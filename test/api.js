const tap = require('tap');
const axios = require('axios');
const ip = require('ip');
const url = require('url');
const mockServer = require('fastify')();

const MOCK_PORT = parseInt(process.env.MOCK_PORT, 10) || 9999;
const HOST = 'http://localhost:3000/';
const MALFORMED_PAYLOAD = 'test';
const IMAGE_URL = 'http://placekitten.com/200/300';

const API = axios.create({
    baseURL: HOST
});

const LISTEN_IP = ip.address();

const address = `http://${LISTEN_IP}:${MOCK_PORT}`;

mockServer.patch('/callback', (req, res) => {
    res.send('OK');

    tap.test('includes thumbnail url', t => {
        t.includes(req.body, {
            thumbnail: url.resolve(address, '/upload')
        });

        t.end();
    }).then(() => process.exit());
});

mockServer.addContentTypeParser('image/png', (req, done) =>
    done(null, req.body)
);
mockServer.put('/upload', (req, res) => {
    res.send('OK');
});

mockServer.listen(MOCK_PORT, LISTEN_IP, err => {
    if (err) throw err;

    tap.test('fail on wrong payload', t => {
        API.post('/filepreview').catch(e => {
            t.equal(e.response.status, 415);
            t.end();
        });
    });

    tap.test('fail on malformed payload', t => {
        API.post('/filepreview', {
            callbackUrl: MALFORMED_PAYLOAD,
            downloadUrl: MALFORMED_PAYLOAD,
            signedS3Url: MALFORMED_PAYLOAD
        }).catch(e => {
            t.equal(e.response.status, 400);
            t.end();
        });
    });

    tap.test('queues request', t => {
        API.post('/filepreview', {
            callbackUrl: url.resolve(address, '/callback'),
            downloadUrl: IMAGE_URL,
            signedS3Url: url.resolve(address, '/upload?dummy=dummy')
        }).then(response => {
            t.equal(response.status, 200);
            t.end();
        });
    });
});
