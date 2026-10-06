import type { TransactionClient } from "neoorm";
import { schema } from "./schema.js";

export async function seed(db: TransactionClient<typeof schema._tables>) {
	await db.users.upsert({
		where: { email: "admin@example.com" },
		create: {
			email: "admin@example.com",
			name: "Admin",
			password: "not-a-real-hash",
		},
		update: {},
	});
	await db.tags.createMany({
		data: [
			{ slug: "news", name: "News" },
			{ slug: "guides", name: "Guides" },
		],
		skipDuplicates: true,
	});
}
