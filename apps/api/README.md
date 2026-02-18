# API (First Build)

## Run

1. Copy `.env.example` to `.env`
2. `npm run prisma:generate`
3. `npm run prisma:migrate`
4. `npm run prisma:seed`
5. `npm run start:dev`

## Implemented Endpoints

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET/POST/PUT/DELETE /api/users` (admin only)
- `GET/POST/PUT/DELETE /api/skus`
- `GET/POST/PUT/DELETE /api/shelves`
- `GET/POST/PUT/DELETE /api/boxes`
- `GET /api/audit-logs`
- `GET /api/boxes/:id/audit-logs`
- `GET /api/skus/:id/audit-logs`
