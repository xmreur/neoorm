import type { FkInverseName } from "../src/schema/relation-types.js";

type CookieInv = FkInverseName<"", "cookies", true>;
type MovieInv = FkInverseName<"", "movies", true>;
type CategoryInv = FkInverseName<"", "categories", true>;

const cookie: CookieInv = "cookie";
const movie: MovieInv = "movie";
const category: CategoryInv = "category";
void cookie;
void movie;
void category;

// @ts-expect-error -ie nouns add -s; cookies does not reverse to cooky
const cooky: CookieInv = "cooky";
void cooky;

// @ts-expect-error -ie nouns add -s; movies does not reverse to movy
const movy: MovieInv = "movy";
void movy;
