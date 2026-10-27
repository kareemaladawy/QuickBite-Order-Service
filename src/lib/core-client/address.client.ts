import { coreClient } from "./core-client";
import { CoreEnvelope, InternalCustomerAddressDTO } from "./types";

// Not cached — looked up once per order placement, not a repeated hot key.
export async function getCustomerAddress(
    addressId: number,
    correlationId?: string,
): Promise<InternalCustomerAddressDTO> {
    const res = await coreClient.request<CoreEnvelope<InternalCustomerAddressDTO>>({
        method: "GET",
        path: `/api/v1/internal/customer-addresses/${addressId}`,
        correlationId,
    });
    return res.data;
}
