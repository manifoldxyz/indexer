import { db } from "@/common/db";

export type GetOwnersFilter = {
  contract?: string;
  tokenId?: string;
  collection?: string;
  owner?: string;
  attributes?: { [key: string]: string };
  offset: number;
  limit: number;
};

export const getOwners = async (filter: GetOwnersFilter) => {
  let baseQuery = `
    select
      "o"."owner",
      sum("o"."amount") as "token_count",
      count(distinct("t"."token_id")) filter (where "t"."floor_sell_hash" is not null) as "on_sale_count",
      min("t"."floor_sell_value") as "floor_sell_value",
      max("t"."top_buy_value") as "top_buy_value",
      sum("o"."amount") * max("t"."top_buy_value") as "total_buy_value"
    from "ownerships" "o"
    join "tokens" "t"
      on "o"."contract" = "t"."contract"
      and "o"."token_id" = "t"."token_id"
      and "o"."amount" > 0
  `;

  // Filters
  const conditions: string[] = [];
  if (filter.contract) {
    conditions.push(`"t"."contract" = $/contract/`);
  }
  if (filter.tokenId) {
    conditions.push(`"t"."token_id" = $/tokenId/`);
  }
  if (filter.collection) {
    conditions.push(`"t"."collection_id" = $/collection/`);
  }
  if (filter.owner) {
    conditions.push(`"o"."owner" = $/owner/`);
  }
  if (filter.attributes) {
    Object.entries(filter.attributes).forEach(([key, value], i) => {
      conditions.push(`
        exists(
          select from "attributes" "a"
          where "a"."contract" = "t"."contract"
            and "a"."token_id" = "t"."token_id"
            and "a"."key" = $/key${i}/
            and "a"."value" = $/value${i}/
        )
      `);
      (filter as any)[`key${i}`] = key;
      (filter as any)[`value${i}`] = value;
    });
  }
  if (conditions.length) {
    baseQuery += " where " + conditions.map((c) => `(${c})`).join(" and ");
  }

  // Grouping
  baseQuery += ` group by "o"."owner"`;

  // Sorting
  baseQuery += ` order by "token_count" desc, "o"."owner"`;

  // Pagination
  baseQuery += ` offset $/offset/`;
  baseQuery += ` limit $/limit/`;

  return db.manyOrNone(baseQuery, filter).then((result) =>
    result.map((r) => ({
      address: r.owner,
      ownership: {
        tokenCount: r.token_count,
        onSaleCount: r.on_sale_count,
        floorSellValue: r.floor_sell_value,
        topBuyValue: r.top_buy_value,
        totalBuyValue: r.total_buy_value,
      },
    }))
  );
};
