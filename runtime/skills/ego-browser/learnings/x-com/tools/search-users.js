export async function searchUsers(ctx, args = {}) {
  const query = args.query || "";
  if (!query) throw new Error("search query is required");

  await ctx.browser.openOrReuseTab(
    `https://x.com/search?f=user&q=${encodeURIComponent(query)}`,
    { wait: true },
  );
  await ctx.page.waitForLoadState("load");

  const users = await ctx.page
    .locator('[data-testid="cellInnerDiv"]')
    .evaluateAll((results) => {
      return results
        .map((el) => ({
          name:
            el
              .querySelector('[data-testid="User-Name"] span')
              ?.innerText?.trim() || "",
          handle:
            el
              .querySelector('[data-testid="User-Name"] a')
              ?.innerText?.trim() || "",
          followers:
            el
              .querySelector('[data-testid="Follow"]')
              ?.previousElementSibling?.innerText?.trim() || "",
        }))
        .filter((u) => u.name || u.handle);
    });

  return users;
}
