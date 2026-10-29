import {Router} from "express";
import {healthRouter} from "./app/health/health.routes";
import {orderRouter} from "./app/order/routes";
import {paymentRouter} from "./app/payment/routes";

export const routes = Router();

routes.use("/health", healthRouter);
routes.use("/", orderRouter);
routes.use("/", paymentRouter);
// Domain modules register here in later phases:
//   routes.use('/deliveries', deliveryRouter);
//   ...
