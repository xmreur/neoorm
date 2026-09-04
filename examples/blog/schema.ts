import {
	bool,
	decimal,
	defineSchema,
	enumType,
	fk,
	id,
	int,
	jsonb,
	manyToMany,
	table,
	text,
	timestamp,
	timestamps,
	uuid,
} from "neoorm/schema";

export const schema = defineSchema({
	users: table({
		id: uuid().primary(),
		email: text().notNull().unique(),
		name: text(),
		...timestamps(),
	}),

	profiles: table({
		id: id(),
		userId: fk("users")
			.notNull()
			.unique()
			.onDelete("cascade")
			.inverse("profile"),
		bio: text(),
		avatarUrl: text(),
	}),

	posts: table({
		id: id(),
		authorId: fk("users")
			.notNull()
			.index()
			.onDelete("restrict")
			.inverse("posts"),
		title: text().notNull(),
		body: text().notNull(),
		published: bool().notNull().default(false),
		views: int().notNull().default(0),
		status: enumType(["draft", "published", "archived"])
			.notNull()
			.default("draft"),
		metadata: jsonb<Record<string, unknown>>(),
		price: decimal({ precision: 10, scale: 2 }),
		...timestamps(),
		tags: manyToMany("tags"),
	}),

	comments: table({
		id: id(),
		postId: fk("posts").notNull().onDelete("cascade").inverse("comments"),
		authorId: fk("users").notNull(),
		body: text().notNull(),
		createdAt: timestamps().createdAt,
	}),

	tags: table({
		id: id(),
		slug: text().notNull().unique(),
		name: text().notNull(),
	}),
});
