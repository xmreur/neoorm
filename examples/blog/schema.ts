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
	uuid,
} from "neoorm/schema";

export const schema = defineSchema({
	users: table("users", {
		id: uuid().primary(),
		email: text().notNull().unique(),
		name: text(),
		createdAt: timestamp().notNull().defaultNow(),
		updatedAt: timestamp().notNull().defaultNow().updatedAt(),
	}),

	profiles: table("profiles", {
		id: id.primary(),
		// `as`/`inverse` can be overridden; `unique` makes it a to-one relation.
		userId: fk("users.id", {
			inverse: "profile",
			unique: true,
			onDelete: "cascade",
		}).notNull(),
		bio: text(),
		avatarUrl: text(),
	}),

	posts: table("posts", {
		id: id.primary(),
		// `.index()` on a column is shorthand for a single-column index.
		authorId: fk("users.id", {
			inverse: "posts",
			onDelete: "restrict",
		})
			.notNull()
			.index(),
		title: text().notNull(),
		body: text().notNull(),
		published: bool().notNull().default(false),
		views: int().notNull().default(0),
		status: enumType(["draft", "published", "archived"] as const)
			.notNull()
			.default("draft"),
		metadata: jsonb<Record<string, unknown>>(),
		price: decimal({ precision: 10, scale: 2 }),
		createdAt: timestamp().notNull().defaultNow(),
		updatedAt: timestamp().notNull().defaultNow().updatedAt(),
	}),

	comments: table("comments", {
		id: id.primary(),
		postId: fk("posts.id", {
			inverse: "comments",
			onDelete: "cascade",
		}).notNull(),
		authorId: fk("users.id", {
			inverse: "comments",
		}).notNull(),
		body: text().notNull(),
		createdAt: timestamp().notNull().defaultNow(),
	}),

	tags: table("tags", {
		id: id.primary(),
		slug: text().notNull().unique(),
		name: text().notNull(),
	}),

	postTags: table("post_tags", {
		// Composite primary key inline via `.primary()` on the FK columns.
		postId: fk("posts.id", {
			inverse: "postTags",
		}).primary(),
		tagId: fk("tags.id", {
			inverse: "postTags",
		}).primary(),
		assignedBy: text(),
		assignedAt: timestamp().notNull().defaultNow(),
	}),
});

manyToMany(schema.posts, schema.tags, {
	through: schema.postTags,
	left: "post",
	right: "tag",
	as: "tags",
	inverse: "posts",
});
