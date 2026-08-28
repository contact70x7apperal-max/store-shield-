import { redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { login } from "../../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (shop) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData();

  return (
    <div style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>StoreShield</h1>
      <p>This app must be opened from inside a Shopify store admin.</p>
      {showForm && (
        <form method="post" action="/auth/login">
          <label>
            Shop domain
            <input type="text" name="shop" placeholder="my-shop.myshopify.com" />
          </label>
          <button type="submit">Log in</button>
        </form>
      )}
    </div>
  );
}
