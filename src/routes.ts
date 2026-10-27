import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";

export const routes = Router();

routes.use("/health", healthRouter);
routes.use("/", orderRouter);
// Domain modules register here in later phases:
//   routes.use('/payments', paymentRouter);
//   ...
