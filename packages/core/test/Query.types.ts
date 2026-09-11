import type { Relations } from "../src/schema/Schema"
import type {
	FieldWhereOperators,
	RelationalQueryOptions,
	RelationalQueryResult,
} from "../src/query/Query"
import type { Assert, TestIsEqual } from "../src/utils/typeUtils"

type _RelationalQueryTestSchema = {
	users: { id: string; name: string }
	threads: { id: string; ownerId: string; title: string; status: string }
	messages: { id: string; threadId: string; body: string; createdAt: number }
	profiles: { id: string; userId: string; displayName: string }
}

type _RelationalQueryTestRelations = Relations<
	_RelationalQueryTestSchema,
	{
		threads: {
			owner: {
				type: "many-to-one"
				targetCollection: "users"
				from: "ownerId"
				to: "id"
			}
			messages: {
				type: "one-to-many"
				targetCollection: "messages"
				from: "id"
				to: "threadId"
			}
		}
		messages: {
			thread: {
				type: "many-to-one"
				targetCollection: "threads"
				from: "threadId"
				to: "id"
			}
		}
		users: {
			profile: {
				type: "many-to-one"
				targetCollection: "profiles"
				from: "id"
				to: "id"
			}
		}
	}
>

type _ThreadQueryOptions = RelationalQueryOptions<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	"threads"
>

type _AssertExtends<_A extends _B, _B> = void

type _TestRelationalSelectFields = _AssertExtends<
	keyof NonNullable<_ThreadQueryOptions["select"]>,
	"id" | "ownerId" | "title" | "status"
>
type _TestRelationalSelectFieldsReverse = _AssertExtends<
	"id" | "ownerId" | "title" | "status",
	keyof NonNullable<_ThreadQueryOptions["select"]>
>
type _TestRelationalWhereValue = _AssertExtends<
	NonNullable<_ThreadQueryOptions["where"]>["status"],
	string | FieldWhereOperators<string> | undefined
>
type _TestRelationalWhereValueReverse = _AssertExtends<
	string | FieldWhereOperators<string> | undefined,
	NonNullable<_ThreadQueryOptions["where"]>["status"]
>
type _TestRelationalOrderByValue = _AssertExtends<
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"],
	"asc" | "desc" | undefined
>
type _TestRelationalOrderByValueReverse = _AssertExtends<
	"asc" | "desc" | undefined,
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"]
>
type _TestRelationalWithRelations = _AssertExtends<
	keyof NonNullable<_ThreadQueryOptions["with"]>,
	"owner" | "messages"
>
type _TestRelationalWithRelationsReverse = _AssertExtends<
	"owner" | "messages",
	keyof NonNullable<_ThreadQueryOptions["with"]>
>

type _OwnerQueryOptions = Exclude<
	NonNullable<_ThreadQueryOptions["with"]>["owner"],
	true | undefined
>
type _TestNestedWithScopesToTargetCollection = _AssertExtends<
	keyof NonNullable<_OwnerQueryOptions["select"]>,
	"id" | "name"
>
type _TestNestedWithScopesToTargetCollectionReverse = _AssertExtends<
	"id" | "name",
	keyof NonNullable<_OwnerQueryOptions["select"]>
>

type _TestRelationalInvalidCollection = RelationalQueryOptions<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Root collections must exist on the schema
	"missing"
>

type _TestRelationalInvalidSelectField = NonNullable<
	_ThreadQueryOptions["select"]
	// @ts-expect-error Selected fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidWhereField = NonNullable<
	_ThreadQueryOptions["where"]
	// @ts-expect-error Where fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidWhereValue = _AssertExtends<
	// @ts-expect-error Where equality values must match the field type
	123,
	NonNullable<_ThreadQueryOptions["where"]>["status"]
>

type _TestRelationalInvalidOrderByField = NonNullable<
	_ThreadQueryOptions["orderBy"]
	// @ts-expect-error Order fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidOrderByValue = _AssertExtends<
	// @ts-expect-error Order directions must be asc or desc
	"up",
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"]
>

type _TestRelationalInvalidRelation = NonNullable<
	_ThreadQueryOptions["with"]
	// @ts-expect-error Relation names must exist on the current collection
>["missingRelation"]

type _TestRelationalInvalidNestedSelect = NonNullable<
	_OwnerQueryOptions["select"]
	// @ts-expect-error Nested relation options are scoped to the target collection
>["title"]

type _TestRelationalOmittedSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads" }
		>,
		_RelationalQueryTestSchema["threads"][]
	>
>
type _TestRelationalSingleSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true } }
		>,
		{ id: string }[]
	>
>
type _TestRelationalMultiSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true; title: true } }
		>,
		{ id: string; title: string }[]
	>
>

type _TestRelationalInvalidSelectValue = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Select values must be true
	{
		collection: "threads"
		select: {
			id: false
		}
	}
>

type _TestRelationalManyToOneResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { owner: { select: { name: true } } }
			}
		>,
		{ id: string; readonly owner: { name: string } | null }[]
	>
>
type _TestRelationalOneToManyResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { messages: { select: { body: true } } }
			}
		>,
		{ id: string; readonly messages: { body: string }[] }[]
	>
>
type _TestRelationalOneToManyLimitOneResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { messages: { select: { body: true }; limit: 1 } }
			}
		>,
		{ id: string; readonly messages: { body: string }[] }[]
	>
>
type _TestRelationalTrueIncludeResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true }; with: { owner: true } }
		>,
		{ id: string; readonly owner: _RelationalQueryTestSchema["users"] | null }[]
	>
>
type _TestRelationalNestedWithResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: {
					owner: {
						select: { name: true }
						with: { profile: { select: { displayName: true } } }
					}
				}
			}
		>,
		{
			id: string
			readonly owner: {
				name: string
				readonly profile: { displayName: string } | null
			} | null
		}[]
	>
>

type _TestRelationalInvalidNestedResultSelect = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Nested selected fields must exist on the relation target collection
	{
		collection: "threads"
		with: {
			owner: {
				select: {
					title: true
				}
			}
		}
	}
>

type _TestRelationalInvalidNestedResultRelation = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Nested relation names must exist on the relation target collection
	{
		collection: "threads"
		with: {
			owner: {
				with: {
					messages: true
				}
			}
		}
	}
>
