# Kitchen Planner

Next.js kitchen planning workspace with a Postgres-backed import workflow, deterministic production calculations, and manager-triggered planning specialists.

## Local setup

1. Install dependencies with pnpm.
2. Copy `.env.example` to `.env.local` and fill the values locally. `DATABASE_URL` points to PostgreSQL; `OPENAI_API_KEY` is used only by the server after a manager clicks **Run planning agents**; `KITCHEN_IMPORT_TOKEN` protects production imports. Do not commit `.env.local`.
3. Run `pnpm db:push` and `pnpm db:seed` after the database is available.
4. Run `pnpm dev` to start the app, or `pnpm build` to verify a production build.
5. Import stock, HR staff, approved leave, part-time availability, then the CRM CSV through the app.

## Vercel deployment

Connect this repository to a Vercel project and attach a hosted PostgreSQL database. Configure `DATABASE_URL`, `OPENAI_API_KEY`, and `KITCHEN_IMPORT_TOKEN` as server-side environment variables. Push the Prisma schema and seed the three JSON files in `reference-data/` once for the hosted database. The operational exports in `operating-data/` are deliberately excluded from Git; upload those files through the deployed app.

The Gmail supplier text is a review-only draft. The app does not send email or book staff.

