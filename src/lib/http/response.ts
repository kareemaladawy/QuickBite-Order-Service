import { Response } from "express";
import { PaginationMeta } from "./pagination/types";
import { ApiResponse } from "./types";

export function sendSuccess<T>(res: Response, data: T, statusCode = 200, meta?: object) {
    const body: ApiResponse<T> = { data };
    if (meta) body.meta = meta;
    res.status(statusCode).json(body);
}

export function sendPaginated<T>(res: Response, data: T[], meta: PaginationMeta) {
    res.status(200).json({ data, meta });
}
