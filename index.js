const express = require('express');
const multer = require('multer');

const upload = multer({});

const app = express();

const xrpcServer = 'http://localhost:2583/xrpc/';

function xrpcPost(endpoint, request, accessToken = '') {
  return fetch(xrpcServer + endpoint, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'authorization': accessToken},
    body: JSON.stringify(request)
  });
}

function xrpcGet(endpoint, accessToken = '') {
  return fetch(xrpcServer + endpoint, {
    method: 'GET',
    headers: {'authorization': accessToken},
  });
}
const staticPath = 'static';
app.use(express.static('static'));
app.use(express.json());
app.use(upload.none());

function translateAtprotoAuthorToMastodon(atprotoAuthor) {
  return {
    acct: atprotoAuthor.name,
    display_name: atprotoAuthor.displayName,
    username: atprotoAuthor.name,
    id: atprotoAuthor.did,
    avatar: 'http://localhost/avatar.png',
    url: 'http://localhost/didLookup?user=' +
        encodeURIComponent(atprotoAuthor.did),
    fields: [],
  };
}

function translateAtprotoPostToMastodon(atprotoPost) {
  return {
    id: atprotoPost.uri,
        account: translateAtprotoAuthorToMastodon(atprotoPost.author),
        content: atprotoPost.record.text, spoiler_text: '', tags: [], pleroma: {
          emoji_reactions: [],
        },
        created_at: atprotoPost.record.createdAt, atproto: atprotoPost,
  }
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

async function makeTimelineUrl(endpoint, limit, maxId, authorization) {
  let ret = `${endpoint}?limit=${encodeURIComponent(limit || '')}`;
  if (maxId) {
    ret += `&before=${await translateMaxIdToBefore(maxId, authorization)}`;
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
  const xrpcReq = {
    username: req.body.username,
    email: req.body.email,
    password: req.body.password
  };
  const xrpcRes = await xrpcPost('com.atproto.createAccount', xrpcReq);
  const xrpcJson = await xrpcRes.json();
  console.log(xrpcJson);
  res.status(xrpcRes.status).json({upstream_error: xrpcJson});
});

app.get('/api/v1/notifications', (req, res) => {
  res.status(200).json([]);
});

app.get('/main/:pagetype', (req, res) => {
  res.sendFile('index.html', {root: staticPath});
});

const port = process.env.PORT || 3000;

app.listen(port, () => {console.log(`atproto-frio listening on port ${port}`)})
