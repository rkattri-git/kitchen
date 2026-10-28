# Kitchen Planner design

## Purpose and users
The kitchen manager uses this app to turn one weekly CRM order export into next week's production plan, named draft roster, stock request and action dashboard. The owner imports HR exports and stock counts. The manager reviews exceptions, roster and supplier draft.

## Inputs and storage
Read `Kitchen_Planner_Learner_Brief.md` and `operating-data/` for the complete business rules and file schemas. Seed `scenario.json`, `products_and_recipes.json` and `supplier.json` as reference data. Through the deployed app, import `current_inventory.json` and the three HR JSON files, then upload the weekly CRM CSV. Validate in the backend, save accepted records and source details to persistent Postgres, and calculate from saved records. Show errors without replacing the last good plan. Re-importing the same export must not double-count. Keep secrets and database access on the server.

## Workflow and three app agents
First use testable code to calculate eligible orders, daily quantities, labour and ingredient demand, a named draft roster and whole stock packs. The cutoff is Wednesday 28 October 2026, 12:00 noon Singapore time, for production on 2–6 November. Show later orders for manager review.
1. Sales & Production Planning Agent: verified order and production results -> explanation of the late exception and dated production actions.
2. Manpower Planning Agent: verified labour demand and roster + approved leave, confirmed part-time availability and Sales agent result -> explanation of gaps and a part-time cover request. Never claim an unconfirmed worker is booked.
3. Purchasing Agent: verified ingredient demand and pack request + Sales agent result -> explanation of shortages and reviewed supplier draft text for `redmartorder@gmail.com`.
The backend controller calls these three specialists through the OpenAI API when I click Run planning agents and passes the Sales result to the other two. Save their recommendations with the current import version. The agents may explain and recommend; they must not overwrite calculated numbers, book staff or send an email. Offer a separate reviewed Gmail Create Draft action through Zapier MCP.

## Dashboard and passing result
Show source/export/import status, eligible and excluded orders, daily production, labour, named roster, leave exceptions and stock request. A Run planning agents button calls the OpenAI API from the backend with `gpt-6-luna` and shows three agent recommendations, a handoff trace and a dated action plan. The app must work at my Vercel URL with frontend and backend in one project. Imports and agent results must survive reload and need no redeployment. I can explain one number from source to result and show the unsent draft in my Gmail Drafts.

