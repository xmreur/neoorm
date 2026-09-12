import { describe, expect, it } from "vitest";
import { modelTypeName } from "../src/codegen/manifest-relations.js";
import { singularize } from "../src/utils/inflect.js";

describe("singularize", () => {
	it("singularizes regular plurals", () => {
		expect(singularize("users")).toBe("user");
		expect(singularize("posts")).toBe("post");
		expect(singularize("tags")).toBe("tag");
		expect(singularize("categories")).toBe("category");
		expect(singularize("addresses")).toBe("address");
		expect(singularize("boxes")).toBe("box");
		expect(singularize("statuses")).toBe("status");
		expect(singularize("buses")).toBe("bus");
		expect(singularize("houses")).toBe("house");
	});

	it("keeps already-singular words ending in s", () => {
		expect(singularize("status")).toBe("status");
		expect(singularize("address")).toBe("address");
		expect(singularize("class")).toBe("class");
		expect(singularize("bonus")).toBe("bonus");
		expect(singularize("analysis")).toBe("analysis");
		expect(singularize("news")).toBe("news");
		expect(singularize("series")).toBe("series");
		expect(singularize("species")).toBe("species");
	});
});

describe("modelTypeName", () => {
	it("emits a singular PascalCase entity type", () => {
		expect(modelTypeName("users")).toBe("User");
		expect(modelTypeName("posts")).toBe("Post");
		expect(modelTypeName("status")).toBe("Status");
		expect(modelTypeName("address")).toBe("Address");
		expect(modelTypeName("news")).toBe("News");
		expect(modelTypeName("profile")).toBe("Profile");
		expect(modelTypeName("categories")).toBe("Category");
		expect(modelTypeName("blog_posts")).toBe("BlogPost");
	});
});
