import {
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLSchema,
  GraphQLString,
  graphql,
  type GraphQLFieldConfigMap,
  type GraphQLOutputType,
} from 'graphql';
import type { SiteContext } from '@modulo/kernel';

/**
 * A GraphQL API generated from the site's composed models (headless out of
 * the box). Resolvers go through repositories, so access rules, RLS and hooks
 * apply exactly as for REST.
 */
const JSONScalar = new GraphQLScalarType({ name: 'JSON', serialize: (v) => v, parseValue: (v) => v, parseLiteral: (ast: any) => parseLit(ast) });
function parseLit(ast: any): unknown {
  switch (ast.kind) {
    case 'StringValue':
    case 'BooleanValue':
      return ast.value;
    case 'IntValue':
    case 'FloatValue':
      return Number(ast.value);
    case 'ObjectValue':
      return Object.fromEntries(ast.fields.map((f: any) => [f.name.value, parseLit(f.value)]));
    case 'ListValue':
      return ast.values.map(parseLit);
    default:
      return null;
  }
}

const typeName = (model: string) => model.split(/[._]/).map((p) => p[0]!.toUpperCase() + p.slice(1)).join('');
const fieldName = (model: string) => model.replace('.', '_');

const cache = new WeakMap<object, GraphQLSchema>();

export function buildSchema(ctx: SiteContext): GraphQLSchema {
  const cached = cache.get(ctx.runtime);
  if (cached) return cached;
  const models = [...ctx.kernel.models.values()].filter((m) => ctx.runtime.installed.has(m.module));
  const types = new Map<string, GraphQLObjectType>();
  for (const m of models) {
    types.set(
      m.name,
      new GraphQLObjectType({
        name: typeName(m.name),
        description: m.label,
        fields: () => {
          const fields: GraphQLFieldConfigMap<any, SiteContext> = {
            id: { type: new GraphQLNonNull(GraphQLID) },
            created_at: { type: GraphQLString },
            updated_at: { type: GraphQLString },
          };
          for (const f of Object.values(m.fields)) {
            if (!ctx.runtime.installed.has(f.module)) continue;
            let t: GraphQLOutputType = GraphQLString;
            if (f.kind === 'int') t = GraphQLInt;
            else if (f.kind === 'float' || f.kind === 'money') t = GraphQLFloat;
            else if (f.kind === 'boolean') t = GraphQLBoolean;
            else if (f.kind === 'json') t = JSONScalar;
            if (f.kind === 'ref' && types.has(f.model!)) {
              const target = f.model!;
              fields[f.name] = { type: GraphQLID };
              fields[`${f.name}_record`] = {
                type: types.get(target)!,
                resolve: (rec, _a, c: SiteContext) => (rec[f.name] ? c.repo(target).findOne({ id: rec[f.name] }) : null),
              };
            } else fields[f.name] = { type: t };
          }
          for (const c of Object.values(m.computed)) if (ctx.runtime.installed.has(c.module)) fields[c.name] = { type: JSONScalar };
          return fields;
        },
      }),
    );
  }
  const query: GraphQLFieldConfigMap<any, SiteContext> = {};
  const mutation: GraphQLFieldConfigMap<any, SiteContext> = {};
  for (const m of models) {
    const t = types.get(m.name)!;
    const fname = fieldName(m.name);
    query[`${fname}_list`] = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(t))),
      args: { where: { type: JSONScalar }, order: { type: GraphQLString }, limit: { type: GraphQLInt }, offset: { type: GraphQLInt }, search: { type: GraphQLString } },
      resolve: (_r, a, c: SiteContext) => c.repo(m.name).find(a as any),
    };
    query[`${fname}_count`] = { type: GraphQLInt, args: { where: { type: JSONScalar } }, resolve: (_r, a, c: SiteContext) => c.repo(m.name).count(a.where as any) };
    query[fname] = { type: t, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, resolve: (_r, a, c: SiteContext) => c.repo(m.name).findOne({ id: a.id }) };
    mutation[`create_${fname}`] = { type: t, args: { data: { type: new GraphQLNonNull(JSONScalar) } }, resolve: (_r, a, c: SiteContext) => c.repo(m.name).create(a.data as any) };
    mutation[`update_${fname}`] = {
      type: t,
      args: { id: { type: new GraphQLNonNull(GraphQLID) }, data: { type: new GraphQLNonNull(JSONScalar) } },
      resolve: (_r, a, c: SiteContext) => c.repo(m.name).update(a.id as string, a.data as any),
    };
    mutation[`delete_${fname}`] = {
      type: GraphQLBoolean,
      args: { id: { type: new GraphQLNonNull(GraphQLID) } },
      resolve: async (_r, a, c: SiteContext) => (await c.repo(m.name).delete(a.id as string), true),
    };
  }
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({ name: 'Query', fields: Object.keys(query).length ? query : { _empty: { type: GraphQLString } } }),
    mutation: Object.keys(mutation).length ? new GraphQLObjectType({ name: 'Mutation', fields: mutation }) : undefined,
  });
  cache.set(ctx.runtime, schema);
  return schema;
}

export async function executeGraphql(ctx: SiteContext, body: { query?: string; variables?: Record<string, unknown>; operationName?: string }) {
  if (!body?.query || typeof body.query !== 'string' || body.query.length > 20_000) return { errors: [{ message: 'Missing or oversized query' }] };
  return graphql({ schema: buildSchema(ctx), source: body.query, variableValues: body.variables, operationName: body.operationName, contextValue: ctx });
}
