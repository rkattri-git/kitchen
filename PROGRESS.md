# Kitchen Planner progress

Mark an item done only after checking it. Add one short evidence note with a test result, screen, saved database record or live URL.

- [x] Three project files created and reviewed. Evidence: `DESIGN.md`, `AGENTS.md` and `PROGRESS.md` exist in the project.
- [x] App scaffold runs. Evidence: `pnpm build` passed; `pnpm start` served `/` with HTTP 200 and `/api/health` returned `{"status":"ok","app":"kitchen-planner"}`.
- [x] Stock, HR and CRM imports validate, save to Postgres and survive reload. Evidence: local Prisma Postgres schema synced and 3 reference seeds present; API saved stock (4), HR staff (7), leave (2), availability (6) and CRM (16). `/api/imports` returned all five counts after restarting Next; re-uploaded CRM returned `duplicate=true`, version 5, with database counts unchanged at 5 batches / 35 records. Duplicate CRM order IDs returned 422.
- [x] Verified calculations match the supplied rules. Evidence: `/api/plan` calculated 15 eligible orders and excluded late `ORD-016`; total 5,280 sandwiches / 105.6 labour hours; daily quantities, roster, leave, stock shortages and whole-pack requests passed 22 assertions. `next build` passed.
- [x] Run planning agents calls OpenAI and shows three recommendations and a handoff trace. Evidence: after restarting local Prisma Postgres and running Next outside the network sandbox, the manager-triggered `POST /api/agents` returned HTTP 200 in 9.7s; `GET /api/agents` confirmed a saved `gpt-6-luna` run for current import version 5 with five dated Sales actions, one verified cover request, supplier draft text and four handoff trace steps. `/api/plan` remained available with 5,280 sandwiches.
- [x] Dashboard shows next-week plan, exceptions and action list. Evidence: `next build` passed; local `/` returned HTTP 200 with the dashboard shell; 15 live assertions passed across `/api/plan` and `/api/agents`, confirming 15 eligible orders, excluded `ORD-016`, 5,280 sandwiches, 105.6 labour hours, five daily plans, seven named rostered staff, four purchasing rows and the saved `gpt-6-luna` run with dated actions, cover request and handoff trace. Browser automation could not identify the Chrome URL, so verification used the local page and live API responses directly.
- [ ] GitHub repository and Vercel frontend/backend work. URL and evidence:
- [ ] Gmail draft appears unsent in my connected Gmail. Evidence:

Next step: Set up the GitHub repository and deploy the frontend/backend to Vercel with a hosted Postgres database, keeping `operating-data/` and local environment files out of GitHub.
Blocker, if any: Dashboard and agent flow are verified locally. Vercel deployment will need a hosted Postgres `DATABASE_URL`; the local development URL is not for production. This folder is not yet a Git repository; that matters at the publishing step.

