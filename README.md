# PowerClass Backend

Node.js + MySQL backend for PowerClass.
Deployed on Railway.app.

## Files
- `server.js` — main API server
- `package.json` — dependencies
- `.env.example` — copy to `.env` for local dev

## Deploy to Railway
1. Push this folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add MySQL plugin → Railway injects MYSQL_URL automatically
4. Add variable: JWT_SECRET = any long random string
5. Generate domain → copy URL to powerclass.jsx

## Local testing
```
npm install
cp .env.example .env
# fill in your local MySQL URL in .env
npm start
```
