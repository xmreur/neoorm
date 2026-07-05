import type { schema } from "../examples/blog/schema.js";
import type { CreateInput, UpdateInput, WhereInput } from "../src/schema/types.js";

type Schema = typeof schema._tables;

type PostsCreate = CreateInput<Schema["posts"]["_columns"], Schema, "posts">;
type UsersCreate = CreateInput<Schema["users"]["_columns"], Schema, "users">;
type PostsUpdate = UpdateInput<Schema["posts"]["_columns"], Schema, "posts">;
type PostsWhere = WhereInput<Schema["posts"]["_columns"], Schema, "posts">;

function expectPostsCreate(value: PostsCreate): void {
  void value;
}

function expectPostsUpdate(value: PostsUpdate): void {
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

const validUserMinimal: UsersCreate = {
  email: "test@example.com",
};

expectPostsUpdate({
  title: "Updated",
  author: { connect: { id: "user_2" } },
});

// @ts-expect-error -- unknown scalar field
expectPostsCreate({ title: "NeoORM", body: "FK-first relations.", authorId: "user_1", typoTitle: "nope" });

// @ts-expect-error -- unknown relation key
expectPostsCreate({ title: "NeoORM", body: "FK-first relations.", authors: { connect: { id: "user_1" } } });

// @ts-expect-error -- missing required scalar body
expectPostsCreate({ title: "NeoORM", authorId: "user_1" });

// @ts-expect-error -- inverse relation write not supported on create
expectPostsCreate({ title: "NeoORM", body: "FK-first relations.", authorId: "user_1", comments: { connect: { id: "comment_1" } } });

// @ts-expect-error -- M2M connectOrCreate not supported on update
expectPostsUpdate({ tags: { connectOrCreate: [{ where: { slug: "orm" }, create: { slug: "orm", name: "ORM" } }] } });

void validUserMinimal;
