import { describe, expect, test } from "vitest";
import { q } from "./Query";

describe("QueryBuilder", () => {
	// Define a test schema that matches the one used in TandemClient.test.ts
	type TodosSchema = {
		todos: {
			id: string;
			text: string;
			complete: boolean;
			order?: number;
		};
		lists: {
			id: string;
			name: string;
		};
	};

	test("builds basic queries", () => {
		const query = q<TodosSchema, "todos">("todos")
			.select(["id", "text"])
			.where("complete", "=", true)
			.build();

		expect(query).toEqual({
			collection: "todos",
			select: ["id", "text"],
			where: [["complete", "=", true]],
		});
	});

	test("builds queries with multiple where clauses", () => {
		const query = q<TodosSchema, "todos">("todos")
			.where("complete", "=", true)
			.where("order", ">", 5)
			.build();

		expect(query).toEqual({
			collection: "todos",
			where: [
				["complete", "=", true],
				["order", ">", 5],
			],
		});
	});

	test("builds queries with ordering", () => {
		const query = q<TodosSchema, "todos">("todos")
			.order("order", "asc")
			.build();

		expect(query).toEqual({
			collection: "todos",
			order: [["order", "asc"]],
		});
	});

	test("builds queries with multiple order clauses", () => {
		const query = q<TodosSchema, "todos">("todos")
			.order("order", "asc")
			.order("text", "desc")
			.build();

		expect(query).toEqual({
			collection: "todos",
			order: [
				["order", "asc"],
				["text", "desc"],
			],
		});
	});

	test("builds queries with limit", () => {
		const query = q<TodosSchema, "todos">("todos").limit(5).build();

		expect(query).toEqual({
			collection: "todos",
			limit: 5,
		});
	});

	test("builds queries with id shorthand", () => {
		const query = q<TodosSchema, "todos">("todos").id("123").build();

		expect(query).toEqual({
			collection: "todos",
			where: [["id", "=", "123"]],
			limit: 1,
		});
	});

	test("merges multiple select calls", () => {
		const query = q<TodosSchema, "todos">("todos")
			.select(["id"])
			.select(["text"])
			.build();

		expect(query).toEqual({
			collection: "todos",
			select: ["id", "text"],
		});
	});

	test("handles select all with *", () => {
		const query = q<TodosSchema, "todos">("todos").select("*").build();

		expect(query).toEqual({
			collection: "todos",
			select: "*",
		});
	});
});
