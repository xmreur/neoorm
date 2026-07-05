import type { schema } from "../examples/blog/schema.js";
import type { CreateInput, UpdateInput, WhereInput } from "../src/schema/types.js";

type Schema = typeof schema._tables;

type PostsCreate = CreateInput<Schema["posts"]["_columns"], Schema, "posts">;
type UsersCreate = CreateInput<Schema["users"]["_columns"], Schema, "users">;
type PostsUpdate = UpdateInput<Schema["posts"]["_columns"], Schema, "posts">;
type PostsWhere = WhereInput<Schema["posts"]["_columns"], Schema, "posts">;
type ProfilesUpdate = UpdateInput<Schema["profiles"]["_columns"], Schema, "profiles">;

function expectPostsCreate(value: PostsCreate): void {
  void value;
}

function expectPostsUpdate(value: PostsUpdate): void {
  void value;
}

function expectProfilesUpdate(value: ProfilesUpdate): void {
  void value;
}

function expectPostsWhere(value: PostsWhere): void {
  void value;
}

expectPostsWhere({
  status: "published",
  price: { gte: "9.99" },
});

// @ts-expect-error -- decimal columns do not support string contains
expectPostsWhere({ price: { contains: "9" } });

expectPostsCreate({
  title: "NeoORM",
  body: "FK-first relations.",
  author: { connect: { id: "user_1" } },
});

expectPostsCreate({
  title: "NeoORM",
  body: "FK-first relations.",
  authorId: "user_1",
});

expectPostsCreate({
  title: "NeoORM",
  body: "FK-first relations.",
  authorId: "user_1",
  tags: {
    connectOrCreate: [
      {
        where: { slug: "orm" },
        create: { slug: "orm", name: "ORM" },
      },
    ],
  },
});

expectPostsCreate({
  title: "NeoORM",
  body: "FK-first relations.",
  authorId: "user_1",
  comments: {
    create: [{ body: "Hello", author: { connect: { id: "user_1" } } }],
  },
});

const validUserMinimal: UsersCreate = {
  email: "test@example.com",
};

expectPostsUpdate({
  title: "Updated",
  author: { connect: { id: "user_2" } },
});

expectPostsUpdate({
  tags: {
    set: [{ id: "tag_1" }],
    connectOrCreate: [{ where: { slug: "orm" }, create: { slug: "orm", name: "ORM" } }],
  },
});

expectPostsUpdate({
  comments: {
    create: [{ body: "Updated comment", author: { connect: { id: "user_1" } } }],
    set: [{ id: "comment_1" }],
    disconnect: [{ id: "comment_2" }],
  },
});

// @ts-expect-error -- disconnect not allowed on non-nullable outgoing FK
expectPostsUpdate({ author: { disconnect: true } });

// @ts-expect-error -- disconnect not allowed on non-nullable profile user FK
expectProfilesUpdate({ user: { disconnect: true } });

// @ts-expect-error -- unknown scalar field
expectPostsCreate({ title: "NeoORM", body: "FK-first relations.", authorId: "user_1", typoTitle: "nope" });

// @ts-expect-error -- unknown relation key
expectPostsCreate({ title: "NeoORM", body: "FK-first relations.", authors: { connect: { id: "user_1" } } });

// @ts-expect-error -- missing required scalar body
expectPostsCreate({ title: "NeoORM", authorId: "user_1" });

void validUserMinimal;
