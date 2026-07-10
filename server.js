import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import handler from './api/faq-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Manually load .env file
try {
    const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    envFile.split('\n').forEach(line => {
        const [key, value] = line.split('=');
        if (key && value) {
            process.env[key.trim()] = value.trim();
        }
    });
} catch (error) {
    console.log('No .env file found or error reading it');
}

const PORT = process.env.PORT || 8888;

const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === '/api/faq-agent' && req.method === 'POST') {
        let body = '';
        let tooBig = false;

        req.on('data', chunk => {
            body += chunk.toString();
            if (body.length > 200_000) {
                tooBig = true;
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer: 'Payload too large' }));
                req.destroy();
            }
        });

        req.on('end', async () => {
            if (tooBig) return;
            try {
                req.body = JSON.parse(body || '{}');

                res.status = (code) => {
                    res.statusCode = code;
                    return res;
                };

                res.json = (data) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(data));
                    return res;
                };

                await handler(req, res);

            } catch (error) {
                console.error('Error:', error.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ answer: 'Sorry, the server is acting up!' }));
            }
        });
        return;
    }

    // Serve static files from root directory
    const publicDir = path.join(__dirname);
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let filePath = path.normalize(path.join(publicDir, reqPath === '/' ? 'index.html' : reqPath));
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h1>403 - Forbidden</h1>', 'utf-8');
        return;
    }
    const extname = String(path.extname(filePath)).toLowerCase();
    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/html' });
                res.end('<h1>404 - File Not Found</h1>', 'utf-8');
            } else {
                res.writeHead(500);
                res.end('Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`\nServer running at http://localhost:${PORT}/`);
    console.log(`Grants Plumbing & Heating chatbot demo ready!\n`);
});
