import { fk, id, table } from "neoorm/schema";
import type { FkBuilder } from "../src/schema/relation.js";

const users = table({
	id: id(),
});

const posts = table({
	id: id(),
	authorId: fk("users").inverse("posts").notNull().index(),
	reviewerId: fk("users.id"),
});

type ShapeOf<C> =
	C extends FkBuilder<infer T, infer As, infer Inv> ? [T, As, Inv] : never;

type AuthorCol = (typeof posts._columns)["authorId"];
declare const authorShape: ShapeOf<AuthorCol>;
const authorOk: ["users", "", "posts"] = authorShape;
void authorOk;

type ReviewerCol = (typeof posts._columns)["reviewerId"];
declare const reviewerShape: ShapeOf<ReviewerCol>;
const reviewerOk: ["users.id", "", ""] = reviewerShape;
void reviewerOk;
