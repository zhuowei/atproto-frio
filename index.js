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

app.use(express.static('static'));
app.use(express.json());
app.use(upload.none());

app.post('/api/v1/statuses', (req, res) => {
  console.log(req.body);
  res.status(400).json({});
});

app.get('/api/pleroma/frontend_configurations', (req, res) => {
  res.status(200).json({
    pleroma_fe: {},
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

const port = process.env.PORT || 3000;

app.listen(port, () => {console.log(`atproto-frio listening on port ${port}`)})
