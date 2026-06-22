# MyApp — React SPA

React 19 + Vite frontend for the Laravel API in the parent folder.
Authentication uses **Laravel Sanctum** (cookie-based SPA auth).

## Stack
- React 19 + React Router 7
- axios (configured for Sanctum cookies in `src/lib/axios.js`)
- Auth state in `src/context/AuthContext.jsx`, route guard in `src/components/ProtectedRoute.jsx`

## Run (dev)
```bash
npm install      # first time only
npm run dev      # http://localhost:5173
```
The Laravel API must also be running (see project root). API base URL is set in `.env` (`VITE_API_URL`).

## Pages
- `/login`, `/register` — public
- `/dashboard` — protected (redirects to /login when signed out)
