import { AbstractRabbitMqJobHandler } from "@/jobs/abstract-rabbit-mq-job-handler";

import { PendingAskEventsQueue } from "@/elasticsearch/indexes/asks/pending-ask-events-queue";
import { config } from "@/config/index";
import { AskCreatedEventHandler } from "@/elasticsearch/indexes/asks/event-handlers/ask-created";
import { logger } from "@/common/logger";
import { idb } from "@/common/db";

export enum EventKind {
  newSellOrder = "newSellOrder",
  sellOrderUpdated = "sellOrderUpdated",
  SellOrderInactive = "SellOrderInactive",
}

export type ProcessAskEventJobPayload = {
  kind: EventKind;
  data: OrderInfo;
  retries?: number;
};

export class ProcessAskEventJob extends AbstractRabbitMqJobHandler {
  queueName = "process-ask-event-queue";
  maxRetries = 10;
  concurrency = 15;
  persistent = true;
  lazyMode = true;

  protected async process(payload: ProcessAskEventJobPayload) {
    const { kind, data } = payload;
    const retries = payload.retries ?? 0;

    const pendingAskEventsQueue = new PendingAskEventsQueue();

    if (kind === EventKind.SellOrderInactive) {
      const id = new AskCreatedEventHandler(data.id).getAskId();

      await pendingAskEventsQueue.add([{ info: { id }, kind: "delete" }]);
    } else {
      const askDocumentInfo = await new AskCreatedEventHandler(data.id).generateAsk();

      if (askDocumentInfo) {
        await pendingAskEventsQueue.add([{ info: askDocumentInfo, kind: "index" }]);

        if (retries > 0) {
          logger.info(
            this.queueName,
            JSON.stringify({
              message: `generateAsk success. orderId=${data.id}`,
              topic: "debugMissingAsks",
              payload,
            })
          );
        }
      } else if (!["element-erc721", "element-erc1155"].includes(data.kind)) {
        const orderExists = await idb.oneOrNone(
          `SELECT 1 FROM orders WHERE id = $/orderId/ AND orders.side = 'sell' AND orders.fillability_status = 'fillable' AND orders.approval_status = 'approved' LIMIT 1;`,
          {
            orderId: data.id,
          }
        );

        if (orderExists && retries < 5) {
          logger.info(
            this.queueName,
            JSON.stringify({
              message: `generateAsk failed but active order exists - Retrying. orderId=${data.id}`,
              topic: "debugMissingAsks",
              payload,
            })
          );

          payload.retries = retries + 1;

          await this.addToQueue([payload]);
        } else {
          logger.error(
            this.queueName,
            JSON.stringify({
              message: `generateAsk failed due to order missing. orderId=${
                data.id
              }, orderExists=${!!orderExists}, retries=${retries}`,
              topic: "debugMissingAsks",
              payload,
            })
          );
        }
      }
    }
  }

  public async addToQueue(payloads: ProcessAskEventJobPayload[], delay = 0) {
    if (!config.doElasticsearchWork) {
      return;
    }

    await this.sendBatch(payloads.map((payload) => ({ payload, delay })));
  }
}

export const processAskEventJob = new ProcessAskEventJob();

interface OrderInfo {
  id: string;
  side: string;
  contract: string;
  currency: string;
  price: string;
  value: string;
  currency_price: string;
  currency_value: string;
  normalized_value: string;
  currency_normalized_value: string;
  source_id_int: number;
  quantity_filled: number;
  quantity_remaining: number;
  fee_bps: number;
  fillability_status: string;
  approval_status: string;
  created_at: string;
  kind: string;
}
