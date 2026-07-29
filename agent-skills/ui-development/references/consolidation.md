# Component consolidation

Consolidate by user job and behavior, never by visual resemblance alone.

For every pair or family under review:

1. Name the user job, interaction semantics, state model, data boundary,
   accessibility contract, responsive projection, and performance assumptions.
2. Query the catalog and relationship authority before reading broad source:
   `cd frontend && npm run query:design-system -- --related "<job or pattern>"`.
3. Choose exactly one decision:
   - `keep-distinct`: different jobs or behavioral contracts;
   - `extend`: one owned contract already covers the additional state;
   - `supersede`: one pattern fully replaces another with a migration path;
   - `remove`: no supported use remains and usage evidence is empty.
4. Record the decision in `frontend/design-system/relationships.json`.
5. For `supersede` or `remove`, prove imports/usages, replacement coverage,
   story migration, and deprecation state before deleting source.

Do not use reduced component count as a success metric. Prefer fewer variants
inside a coherent contract, but keep separate components when combining them
would introduce unrelated modes, boolean prop matrices, or ambiguous jobs.
