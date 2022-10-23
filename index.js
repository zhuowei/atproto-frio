const express = require('express');
const multer = require('multer');

const upload = multer({});

const app = express();

app.use(express.static('static'));
app.use(upload.none());

app.post('/api/v1/statuses', (req, res) => {
  console.log(req.body);
  res.status(400).json({});
});

app.get('/api/pleroma/frontend_configurations', (req, res) => {
  res.status(200).json({
    pleroma_fe: {
      loginMethod: 'token',
    },
  });
});

app.get('/api/v1/accounts/verify_credentials', (req, res) => {
  res.status(200).json({});
  // res.status(400).json({});
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


app.post('/oauth/token', (req, res) => {
  res.status(200).json({
    access_token: 'TODO-access-token',
    token_type: 'Bearer',
    scope: 'read write follow push admin',
    created_at: 0,
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {console.log(`atproto-frio listening on port ${port}`)})
