import { Jetstream } from "@skyware/jetstream";
import { FastifyInstance } from "fastify";
import type { AppContext } from "./index.js";
import { countGrapheme } from "unicode-segmenter";
import { CHARLIMIT, GRAPHLIMIT } from "./env.js";
import { resolveDid } from "./utils.js";

// TODO: make it not horrible sorry rn im too lazy and i need sleep
//
const getIdentity = async (ctx: AppContext, did: string, nickname?: string) => {
  const account = await ctx.db
    .selectFrom("accounts")
    .where("did", "=", did)
    .selectAll()
    .executeTakeFirst();
  const handle = account === undefined ? await resolveDid(did) : account.handle;
  let res;
  if (account === undefined) {
    await ctx.db
      .insertInto("accounts")
      .values({ did: did, handle: handle, nickname: nickname })
      .execute()
      .catch((err) => ctx.logger.error(err));
  } else if (nickname !== undefined) {
    res = await ctx.db
      .updateTable("accounts")
      .set({ nickname: nickname })
      .where("did", "=", did)
      .execute();
  }
  return { nickname: account?.nickname, handle: handle };
};

export function startJetstream(server: FastifyInstance, ctx: AppContext) {
  const jetstream = new Jetstream({
    wantedCollections: ["social.psky.*"],
    endpoint: "wss://jetstream2.us-west.bsky.network/subscribe",
  });

  jetstream.on("error", (err) => console.error(err));

  jetstream.onCreate("social.psky.actor.profile", async (event) => {
    const nick = event.commit.record.nickname;
    if (nick !== undefined && (countGrapheme(nick) > 32 || nick.length > 320))
      return;

    await getIdentity(ctx, event.did, nick);
    ctx.logger.info(`Created profile ${event.did}`);
  });

  jetstream.onUpdate("social.psky.actor.profile", async (event) => {
    const nick = event.commit.record.nickname;
    if (nick !== undefined && (countGrapheme(nick) > 32 || nick.length > 320))
      return;

    await getIdentity(ctx, event.did, nick);
    ctx.logger.info(`Created profile ${event.did}`);
  });

  jetstream.onDelete("social.psky.actor.profile", async (event) => {
    await ctx.db
      .updateTable("accounts")
      .set({ nickname: "" })
      .where("did", "=", event.did)
      .executeTakeFirst();
    ctx.logger.info(`Deleted profile: ${event.did}`);
  });

  jetstream.onCreate("social.psky.feed.post", async (event) => {
    const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
    const post = event.commit.record.text;
    const facets = event.commit.record.facets;
    const reply = event.commit.record.reply;
    if (countGrapheme(post) > GRAPHLIMIT || post.length > CHARLIMIT) return;
    else if (!countGrapheme(post.trim())) return;

    const identity = await getIdentity(ctx, event.did);

    const timestamp = Date.now();
    const record = {
      $type: "social.psky.feed.post#create",
      did: event.did,
      rkey: event.commit.rkey,
      post: post,
      facets: facets,
      reply: reply,
      handle: identity.handle,
      nickname: identity.nickname,
      indexedAt: timestamp,
    };

    try {
      const res = await ctx.db
        .insertInto("posts")
        .values({
          uri: uri,
          cid: event.commit.cid,
          post: post,
          facets: facets ? JSON.stringify(facets) : null,
          reply: reply ? JSON.stringify(reply) : null,
          account_did: event.did,
          indexed_at: timestamp,
        })
        .executeTakeFirst();
      if (res === undefined) return;
      server.websocketServer.emit("message", JSON.stringify(record));
      ctx.logger.info(`Created post: ${uri}`);
    } catch (err) {
      ctx.logger.error(err);
    }
  });

  jetstream.onUpdate("social.psky.feed.post", async (event) => {
    const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
    const facets = event.commit.record.facets;
    const reply = event.commit.record.reply;
    const timestamp = Date.now();
    await ctx.db
      .updateTable("posts")
      .set({
        post: event.commit.record.text,
        cid: event.commit.cid,
        facets: facets ? JSON.stringify(facets) : null,
        reply: reply ? JSON.stringify(reply) : null,
        updated_at: timestamp,
      })
      .where("uri", "=", uri)
      .executeTakeFirst();
    const record = {
      $type: "social.psky.feed.post#update",
      did: event.did,
      rkey: event.commit.rkey,
      post: event.commit.record.text,
      facets: facets,
      reply: reply,
      updatedAt: timestamp,
    };
    server.websocketServer.emit("message", JSON.stringify(record));
    ctx.logger.info(`Updated post: ${uri}`);
  });

  jetstream.onDelete("social.psky.feed.post", async (event) => {
    const uri = `at://${event.did}/${event.commit.collection}/${event.commit.rkey}`;
    await ctx.db.deleteFrom("posts").where("uri", "=", uri).executeTakeFirst();
    const record = {
      $type: "social.psky.feed.post#delete",
      did: event.did,
      rkey: event.commit.rkey,
    };
    server.websocketServer.emit("message", JSON.stringify(record));
    ctx.logger.info(`Deleted post: ${uri}`);
  });

  jetstream.on("identity", async (event) => {
    const identity = await ctx.db
      .selectFrom("accounts")
      .where("did", "=", event.did)
      .select("handle")
      .executeTakeFirst();
    if (identity !== undefined && event.identity.handle) {
      await ctx.db
        .updateTable("accounts")
        .set({ did: event.did, handle: event.identity.handle })
        .where("did", "=", event.did)
        .execute();
      ctx.logger.info(
        `Updated handle: ${identity.handle} -> ${event.identity.handle}`,
      );
    }
  });

  jetstream.start();
}
