const {fetch} = require('undici');
const express = require('express');
const bodyParser = require('body-parser');
const multer = require('multer');

const upload = multer({});

const app = express();

const singleUserMode = true;
const serverDomain =
    process.env.HOSTNAME || 'please-set-hostname-read-docs.localhost';
const hardcodedInviteCode = process.env.HARDCODED_INVITE_CODE;
const plcServer = process.env.DID_PLC_URL || 'http://localhost:2582';
const xrpcServer = 'http://localhost:2583/xrpc/';

function noAwait(promise) {}

function xrpcPost(endpoint, request, accessToken = '') {
  if (accessToken === 'Bearer TODO-anonymous-access-token') {
    accessToken = '';
  }
  return fetch(xrpcServer + endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'authorization': accessToken},
    body: JSON.stringify(request)
  });
}

function xrpcGet(endpoint, accessToken = '') {
  if (accessToken === 'Bearer TODO-anonymous-access-token') {
    accessToken = '';
  }
  return fetch(xrpcServer + endpoint, {
    method: 'GET',
    headers: {'authorization': accessToken},
  });
}

async function xrpcProxy(req, res, next) {
  const headers = {};
  for (const i of ['content-type', 'authorization']) {
    if (req.headers[i]) {
      headers[i] = req.headers[i];
    }
  }
  console.log(
      'xrpcProxy', headers, req.body, req.method,
      xrpcServer + req.url.substring(1));
  const xrpcResponse = await fetch(
      xrpcServer + req.url.substring(1),
      {method: req.method, headers: headers, body: req.body});
  const body = await xrpcResponse.arrayBuffer();
  console.log('xrpcProxy body', body);
  res.status(xrpcResponse.status)
      .set('content-type', xrpcResponse.headers.get('content-type'))
      .send(Buffer.from(body));
}

app.use(
    '/xrpc/', bodyParser.raw({type: ['application/json', 'application/cbor']}));
app.use('/xrpc/', xrpcProxy);

function didWebUrl(userDid) {
  const parts = userDid.split(':');
  return 'https://' + parts[2] + '/' +
      (userDid.length > 3 ? userDid.slice(3).join('/') : '.well-known') +
      '/did.json';
}

async function lookupPdcFromDid(userDid) {
  console.log('lookupPdcFromDid', userDid);
  if (userDid === 'did:test:hello') {
    return 'http://localhost:3333/xrpc/';
  }
  const didUrl = userDid.startsWith('did:web:') ?
      didWebUrl(userDid) :
      plcServer + '/' + encodeURIComponent(userDid);
  console.log(didUrl);
  const plcResp = await fetch(didUrl);
  const plcJson = await plcResp.json();
  return plcJson.service[0].serviceEndpoint + '/xrpc/';
}

async function getUserFollowers(usernameOrDid, authorization) {
  const xrpcResp = await xrpcGet(
      `app.bsky.getUserFollowers?user=${encodeURIComponent(usernameOrDid)}`,
      authorization);
  const xrpcJson = await xrpcResp.json();
  console.log('getUserFollowers', usernameOrDid, xrpcJson);
  return xrpcJson;
}

async function pushUserToRemotePdc(userDid, localPdc, remotePdc) {
  const remoteRootResp = await fetch(
      `${remotePdc}com.atproto.syncGetRoot?did=${encodeURIComponent(userDid)}`);
  console.log(
      'remoteRootResp',
      `${remotePdc}com.atproto.syncGetRoot?did=${encodeURIComponent(userDid)}`,
      'returned', remoteRootResp.status);
  const remoteRootJson =
      remoteRootResp.status === 200 ? await remoteRootResp.json() : {};
  console.log('remoteRootJson', remoteRootJson);
  const diffToRootResp = await fetch(`${localPdc}com.atproto.syncGetRepo?did=${
      encodeURIComponent(
          userDid)}&from=${encodeURIComponent(remoteRootJson.root || '')}`)
  const diffToRootData = await diffToRootResp.arrayBuffer();
  console.log('diffToRootData', diffToRootData);
  const remotePushResp = await fetch(
      `${remotePdc}com.atproto.syncUpdateRepo?did=${
          encodeURIComponent(userDid)}`,
      {
        method: 'POST',
        headers: {'content-type': 'application/cbor'},
        body: diffToRootData
      });
  console.log(
      'pushing ', localPdc, 'to', remotePdc, 'returns', remotePushResp.status);
  return remotePushResp.status;
}

async function doPushUserToFollowers(authorization, extraCcUsers = []) {
  // port of
  // https://github.com/bluesky-social/atproto/pull/167/files#diff-91afa8406d315505fda81a977a0b63b1b991de2a211293343aea1eae2f225165L268
  // for each follower of user + extra CC users, push the current user's repo to
  // their server. In the dumbest way possible.
  const currentUserDid = getDidFromAuthorizationInsecure(authorization);
  const followers = (await getUserFollowers(currentUserDid, authorization))
                        .followers.map(a => a.did);
  ;
  const extraCcDids = (await Promise.all(extraCcUsers.map(async a => {
                        try {
                          return await usernameToDidRemote(a);
                        } catch (e) {
                          console.log(e);
                          return null;
                        }
                      }))).filter(a => a !== null);
  const pdcLookupsRaw =
      (await Promise.all([...followers, ...extraCcDids].map(async a => {
        try {
          return await lookupPdcFromDid(a);
        } catch (e) {
          console.log(e);
          return null;
        }
      })))
          .filter(
              a => a !== null && a !== serverDomain &&
                  !a.startsWith('localhost:'));
  const pdcLookups = pdcLookupsRaw.filter((v, i, a) => a.indexOf(v) === i);
  console.log('about to push to', pdcLookups);
  const pushResults =
      (await Promise.all(pdcLookups.map(async a => {
        try {
          return await pushUserToRemotePdc(currentUserDid, xrpcServer, a);
        } catch (e) {
          console.log(e);
          return null;
        }
      }))).filter(a => a !== null);
  console.log(pushResults);
}

const staticPath = 'static';
app.use(express.static('static'));
app.use(express.json());
app.use(upload.none());

const forceSyncAllowed = process.env.FORCE_SYNC_ALLOWED ? true : false;

app.get('/force-sync', async (req, res) => {
  if (!forceSyncAllowed) {
    res.status(400).send({});
    return;
  }
  await doPushUserToFollowers(
      req.headers.authorization, req.query.cc ? req.query.cc.split(',') : []);
  res.status(200).send({});
});

app.get('/force-fetch', async (req, res) => {
  if (!forceSyncAllowed) {
    res.status(400).send({});
    return;
  }
  await pushUserToRemotePdc(req.query.from, req.query.remoteServer, xrpcServer);
  res.status(200).send({});
});

function translateAtprotoAuthorToMastodon(atprotoAuthor) {
  return {
    acct: atprotoAuthor.name,
    display_name: atprotoAuthor.displayName,
    username: atprotoAuthor.name,
    id: atprotoAuthor.did,
    avatar: `https://${serverDomain}/images/avi.png`,
    url: `https://${serverDomain}/${atprotoAuthor.name}`,
    fields: [],
  };
}

function translateAtprotoPostToMastodon(atprotoPost) {
  return {
    id: atprotoPost.uri,
    account: translateAtprotoAuthorToMastodon(atprotoPost.author),
    content: atprotoPost.record.text,
    spoiler_text: '',
    tags: [],
    emojis: [],
    pleroma: {
      emoji_reactions: [],
    },
    created_at: atprotoPost.record.createdAt,
    atproto: atprotoPost,
  };
}

function translateAtprotoTimelineToMastodon(atprotoTimeline) {
  return atprotoTimeline.map(translateAtprotoPostToMastodon);
}

async function fetchPostByUri(postUri, authorization) {
  const xrpcRes = await xrpcGet(
      `app.bsky.getPostThread?uri=${encodeURIComponent(postUri)}&depth=1`,
      authorization);
  const xrpcJson = await xrpcRes.json();
  if (xrpcRes.status !== 200) {
    console.log('fetchPost fail', xrpcJson);
    return null;
  }
  return xrpcJson.thread;
}

// there's got to be a better way
async function translateMaxIdToBefore(maxId, authorization) {
  if (!maxId) {
    return '';
  }
  const post = await fetchPostByUri(maxId, authorization);
  if (!post) {
    return '';
  }
  return encodeURIComponent(post.indexedAt);
}

async function makeTimelineUrl(endpoint, limit, maxId, authorization, author) {
  let ret = `${endpoint}?limit=${encodeURIComponent(limit || '')}`;
  if (maxId) {
    ret += `&before=${await translateMaxIdToBefore(maxId, authorization)}`;
  }
  if (author) {
    ret += `&author=${encodeURIComponent(author)}`;
  }
  return ret;
}

app.get('/api/v1/timelines/home', async (req, res) => {
  const xrpcRes = await xrpcGet(
      await makeTimelineUrl(
          'app.bsky.getHomeFeed', req.query.limit, req.query.max_id,
          req.headers.authorization),
      req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  // console.log(xrpcJson);
  res.status(200).json(translateAtprotoTimelineToMastodon(xrpcJson.feed));
});

app.get('/api/v1/accounts/:accountId/statuses', async (req, res) => {
  const xrpcRes = await xrpcGet(
      await makeTimelineUrl(
          'app.bsky.getAuthorFeed', req.query.limit, req.query.max_id,
          req.headers.authorization, req.params.accountId),
      req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  // console.log(xrpcJson);
  res.status(200).json(translateAtprotoTimelineToMastodon(xrpcJson.feed));
});

// This is not secure since the JWT isn't validated
function getDidFromAuthorizationInsecure(authorization) {
  // yolo
  const parts = authorization.split(' ');
  if (parts[0] !== 'Bearer') {
    throw new Error('not bearer');
  }
  return JSON.parse(atob(parts[1].split('.')[1])).sub;
}

app.post('/api/v1/statuses', async (req, res) => {
  const xrpcReq = {
    $type: 'app.bsky.post',
    text: req.body.status,
    createdAt: new Date().toISOString()
  };
  const xrpcRes = await xrpcPost(
      `com.atproto.repoCreateRecord?collection=app.bsky.post&did=${
          encodeURIComponent(
              getDidFromAuthorizationInsecure(req.headers.authorization))}`,
      xrpcReq, req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  if (xrpcRes.status !== 200) {
    res.status(xrpcRes.status).json({error: xrpcJson.message});
    return;
  }
  const post = await fetchPostByUri(xrpcJson.uri, req.headers.authorization);
  res.status(200).json(translateAtprotoPostToMastodon(post));
});

app.get('/api/pleroma/frontend_configurations', (req, res) => {
  res.status(200).json({
    pleroma_fe: {disableChat: true},
  });
});

app.get('/api/v1/accounts/verify_credentials', async (req, res) => {
  const xrpcRes =
      await xrpcGet('com.atproto.getSession', req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  res.status(xrpcRes.status).json({
    upstream_error: xrpcJson,
  });
});

async function usernameToDidRemote(username) {
  if (username.startsWith('did:')) {
    return username;
  }
  const remoteXrpc =
      username.endsWith('.test') ? xrpcServer : `https://${username}/xrpc/`;
  const xrpcRes = await fetch(`${remoteXrpc}com.atproto.resolveName?name=${
      encodeURIComponent(username)}`);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  return xrpcJson.did;
}

app.post('/api/v1/accounts/:accountId/follow', async (req, res) => {
  // Resolve the DID
  const targetUsername = req.params.accountId;
  const targetDid = await usernameToDidRemote(targetUsername);
  const xrpcReq = {
    $type: 'app.bsky.follow',
    subject: targetDid,
    createdAt: new Date().toISOString()
  };
  const xrpcRes = await xrpcPost(
      `com.atproto.repoCreateRecord?collection=app.bsky.follow&did=${
          encodeURIComponent(
              getDidFromAuthorizationInsecure(req.headers.authorization))}`,
      xrpcReq, req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  noAwait(doPushUserToFollowers(req.headers.authorization, [targetDid]));
  const targetPdc = await lookupPdcFromDid(targetDid);
  noAwait(
      pushUserToRemotePdc(targetDid, `https://${targetPdc}/xrpc/`, xrpcServer));
  res.status(xrpcRes.status).json({id: targetDid});
});

app.get('/api/v1/accounts/:accountId', async (req, res) => {
  const xrpcRes = await xrpcGet(
      `app.bsky.getProfile?user=${encodeURIComponent(req.params.accountId)}`,
      req.headers.authorization);
  const xrpcJson = await xrpcRes.json();
  res.status(xrpcRes.status).json(translateAtprotoAuthorToMastodon(xrpcJson));
});

app.post('/api/v1/apps', (req, res) => {
  res.status(200).json({
    id: '0',
    name: 'TODO-name',
    client_id: 'TODO-client-id',
    client_secret: 'TODO-client-secret',
    redirect_uri: 'TODO-redirect-uri',
    vapid_key: 'TODO-vapid-key',
    website: 'TODO-website',
  });
});


app.post('/oauth/token', async (req, res) => {
  if (req.body.grant_type !== 'password') {
    res.status(200).json({
      access_token: 'TODO-anonymous-access-token',
      token_type: 'Bearer',
      scope: 'read write follow push admin',
      created_at: 0,
    });
    return;
  }
  const xrpcReq = {username: req.body.username, password: req.body.password};
  const xrpcRes = await xrpcPost('com.atproto.createSession', xrpcReq);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  if (xrpcRes.status !== 200) {
    res.status(xrpcRes.status).json({
      error: xrpcJson.message,
    });
    return;
  }
  res.status(xrpcRes.status).json({
    access_token: xrpcJson.jwt,
    token_type: 'Bearer',
    scope: 'read write follow push admin',
    created_at: 0,
  });
});

app.post('/oauth/revoke', async (req, res) => {
  // deleteSession is a TODO right now in @atproto/server; we'll try anyways
  const xrpcReq = {};
  const xrpcRes =
      await xrpcPost('com.atproto.deleteSession', xrpcReq, req.body.token);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  res.status(xrpcRes.status).json({error: xrpcJson.message});
});

app.post('/api/v1/accounts', async (req, res) => {
  if (singleUserMode) {
    if (req.body.username !== serverDomain) {
      res.status(400).json({
        error: JSON.stringify(
            {ap_id: [`must be exactly "${serverDomain}" in single user mode`]}),
      });
      return;
    }
  }
  const xrpcReq = {
    username: req.body.username,
    email: req.body.email,
    password: req.body.password
  };
  if (hardcodedInviteCode) {
    xrpcReq.inviteCode = hardcodedInviteCode;
  }
  const xrpcRes = await xrpcPost('com.atproto.createAccount', xrpcReq);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  res.status(xrpcRes.status).json({
    access_token: xrpcJson.jwt,
    token_type: 'Bearer',
    scope: 'read write follow push admin',
    created_at: 0,
    upstream_error: xrpcJson
  });
});

app.get('/api/pleroma/captcha', (req, res) => {
  res.status(200).json({});
});

app.get('/api/v1/notifications', (req, res) => {
  res.status(200).json([]);
});

app.get('/api/v2/search', (req, res) => {
  // TODO(zhuowei): actually point this upstream to search
  res.status(200).json({
    accounts: [{
      acct: req.query.q,
      display_name: req.query.q,
      username: req.query.q,
      id: req.query.q,
      avatar: `https://${serverDomain}/images/avi.png`,
      url: `https://${req.query.q}/${req.query.q}`,
      fields: [],
    }],
    hashtags: [],
    statuses: [],
  });
});

app.get('/api/pleroma/emoji.json', (req, res) => {
  res.status(200).json({});
});

app.get('/main/:pagetype', (req, res) => {
  res.sendFile('index.html', {root: staticPath});
});

app.get('/:username', (req, res) => {
  res.sendFile('index.html', {root: staticPath});
});

const port = process.env.PORT || 3000;

app.listen(port, () => {console.log(`atproto-frio listening on port ${port}`)})
