import {Knex} from "knex";
import {FilterParams, PaginationMeta, PaginationParams} from "./types";

function camelToSnake(str: string): string {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function applyCursorPagination(
    query: Knex.QueryBuilder,
    params: PaginationParams,
): Knex.QueryBuilder {
    if (!params.sortBy) return query;
    const dbColumn = camelToSnake(params.sortBy);
    if (params.cursor) {
        const op = params.sortOrder === "asc" ? ">" : "<";
        query = query.where(dbColumn, op, params.cursor);
    }
    return query.orderBy(dbColumn, params.sortOrder).limit(params.limit + 1);
}

export function applyFilters(
    query: Knex.QueryBuilder,
    filters: FilterParams[],
): Knex.QueryBuilder {
    for (const filter of filters) {
        switch (filter.operator) {
            case "eq":
                query.where(filter.field, filter.value);
                break;
            case "gt":
                query.where(filter.field, ">", filter.value);
                break;
            case "lt":
                query.where(filter.field, "<", filter.value);
                break;
            case "lte":
                query.where(filter.field, "<=", filter.value);
                break;
            case "gte":
                query.where(filter.field, ">=", filter.value);
                break;
            case "like":
                query.whereLike(filter.field, `%${filter.value}%`);
                break;
            case "in":
                query.whereIn(
                    filter.field,
                    Array.isArray(filter.value) ? filter.value : [filter.value],
                );
                break;
        }
    }
    return query;
}

export function buildPaginationResult<T>(
    rows: T[],
    limit: number,
    sortBy: string,
): {data: T[]; meta: PaginationMeta} {
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    let nextCursor: string | null = null;

    if (data.length > 0) {
        const lastItem = data[data.length - 1] as Record<string, unknown>;
        const sortValue = lastItem[sortBy];
        // Date.toString() (e.g. "Mon Oct 19 2026 14:29:53 GMT+0300 ...") is not a stable
        // cursor: applyCursorPagination feeds it straight back into a SQL comparison, so
        // it must round-trip as ISO 8601, not a locale-formatted string.
        nextCursor = hasMore && lastItem
            ? sortValue instanceof Date ? sortValue.toISOString() : String(sortValue)
            : null;
    }
    return {
        data,
        meta: {nextCursor, hasMore, count: data.length},
    };
}
