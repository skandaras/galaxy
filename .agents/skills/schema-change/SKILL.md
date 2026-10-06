---
name: schema-change
description: Changing the database schema: the Drizzle edit, the generated migration, what a rollback to the previous image meets, and removing a column or table completely.
tasks: coding
---

## When to use

Any edit to `src/lib/server/db/schema.ts`.

## Steps

1. **Edit `schema.ts`**, with a comment on the new column or table saying why it is this shape,
   in the style of the file.
2. **Add columns so the previous image can still write.** The promotion and rollback buttons
   swap images over one database, and migrations run on boot, so the image you are replacing
   must keep working against your schema. A new column is nullable or has a default. A
   `NOT NULL` column with no default breaks every insert the old image makes.
3. **Run `npm run db:generate`** and commit the generated SQL in `drizzle/` together with
   `drizzle/meta`. Never write or edit the SQL by hand.
4. **Removing something removes all of it**, in the same change: the column or table, every
   read and write of it, its settings rows, its admin controls and any comment that explains
   it. Do not leave a column for the release after.
5. **Say what a rollback meets in the commit body.** For a drop, name exactly what the previous
   image would fail on. For an addition, say why it does not.
6. **Enums** are TypeScript only in SQLite (`text('x', { enum: [...] })`), so narrowing one
   needs no migration, but rows holding the old value are still there and are read back as the
   string they hold. Decide what happens to them and write it down.

## Tests

- Suites run against a real database per worker, so test through the module functions rather
  than by mocking Drizzle.
- `npm run lint && npm run check && npm test`, and `npm run build`.
