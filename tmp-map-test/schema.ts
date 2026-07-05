import { defineSchema, table, id, text } from 'neoorm/schema';
export const schema = defineSchema({
  users: table('users', {
    id: id.primary(),
    emailAddress: text().notNull().map('email'),
  }),
});
