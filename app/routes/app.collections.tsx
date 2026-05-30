import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, IndexTable,
  Badge, Button, InlineStack, Link, Modal, Box,
  Divider, EmptyState, Spinner, Thumbnail, Banner,
  TextField,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { useState } from "react";

// ── Loader: all collections ───────────────────────────────────────────────────

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop; // e.g. fineystjackets.myshopify.com
  const storeDomain = process.env.SHOP_STORE_URL || `https://${shop}`;
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;

  const res = await admin.graphql(`#graphql
    query($cursor: String) {
      collections(first: 50, after: $cursor, sortKey: TITLE) {
        pageInfo { hasNextPage hasPreviousPage endCursor startCursor }
        edges {
          node {
            id title handle
            productsCount { count }
            sortOrder
            metafields(first: 20) {
              edges { node { id namespace key value type } }
            }
          }
        }
      }
    }
  `, { variables: { cursor } });

  const data = await res.json();
  const conn = data.data.collections;

  return {
    collections: conn.edges.map((e: any) => ({
      id:           e.node.id,
      title:        e.node.title,
      handle:       e.node.handle,
      productCount: e.node.productsCount?.count ?? 0,
      sortOrder:    e.node.sortOrder,
      shopifyUrl:   `${storeDomain}/collections/${e.node.handle}`,
      metafields:   e.node.metafields.edges.map((m: any) => m.node),
    })),
    pageInfo: conn.pageInfo,
  };
};

// ── Action: fetch products inside a collection + edit metafields ──────────────

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  // Load all products in a collection
  if (intent === "load-products") {
    const collectionId = formData.get("collectionId") as string;
    const products: any[] = [];
    let cursor: string | null = null;

    while (true) {
      const res = await admin.graphql(`#graphql
        query($id: ID!, $after: String) {
          collection(id: $id) {
            products(first: 50, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges {
                node {
                  id title handle status
                  featuredImage { url altText }
                  metafields(first: 30) {
                    edges { node { id namespace key value type } }
                  }
                }
              }
            }
          }
        }
      `, { variables: { id: collectionId, after: cursor } });

      const data = await res.json();
      const page = data.data.collection.products;

      for (const e of page.edges) {
        products.push({
          id:         e.node.id,
          title:      e.node.title,
          handle:     e.node.handle,
          status:     e.node.status,
          image:      e.node.featuredImage?.url ?? null,
          metafields: e.node.metafields.edges.map((m: any) => m.node),
        });
      }

      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    return { intent: "load-products", products };
  }

  // Save a metafield edit
  if (intent === "save-metafield") {
    const productId = formData.get("productId") as string;
    const namespace = formData.get("namespace") as string;
    const key       = formData.get("key")       as string;
    const value     = formData.get("value")     as string;
    const type      = formData.get("type")      as string;

    const res = await admin.graphql(`#graphql
      mutation($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id namespace key value }
          userErrors { field message }
        }
      }
    `, {
      variables: {
        metafields: [{ ownerId: productId, namespace, key, value, type }],
      },
    });

    const data = await res.json();
    const errors = data.data.metafieldsSet.userErrors;
    if (errors.length > 0) return { intent: "save-metafield", success: false, error: errors[0].message };
    return { intent: "save-metafield", success: true };
  }

  return null;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function PriorityBadge({ metafields }: { metafields: any[] }) {
  const p = metafields.find((m: any) => m.namespace === "custom" && m.key === "priority");
  if (!p) return <Text as="span" tone="subdued" variant="bodySm">—</Text>;
  const toneMap: Record<string, any> = { "1": "success", "2": "info", "3": "attention", "5": "critical" };
  return <Badge tone={toneMap[p.value]}>P{p.value}</Badge>;
}

function MetaNamespaceBadge({ namespace }: { namespace: string }) {
  const tones: Record<string, any> = { custom: "info", seo: "success", global: "attention" };
  return <Badge tone={tones[namespace] ?? undefined}>{namespace}</Badge>;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Collections() {
  const { collections, pageInfo } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  // Collection metafield modal state
  const [collMetaModal, setCollMetaModal] = useState<any | null>(null);

  // Products modal state
  const [productsModal, setProductsModal]     = useState<{ collection: any } | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [editingMeta, setEditingMeta]         = useState<any | null>(null);
  const [editValue, setEditValue]             = useState("");

  const isLoadingProducts = fetcher.state !== "idle" && !fetcher.data;
  const loadedProducts    = fetcher.data?.intent === "load-products" ? fetcher.data.products : null;
  const isSaving          = fetcher.state !== "idle" && fetcher.data?.intent === "save-metafield";

  const handleOpenProducts = (coll: any) => {
    setProductsModal({ collection: coll });
    setSelectedProduct(null);
    setEditingMeta(null);
    fetcher.submit(
      { intent: "load-products", collectionId: coll.id },
      { method: "POST" }
    );
  };

  const handleSaveMeta = () => {
    if (!editingMeta || !selectedProduct) return;
    fetcher.submit(
      {
        intent:    "save-metafield",
        productId: selectedProduct.id,
        namespace: editingMeta.namespace,
        key:       editingMeta.key,
        value:     editValue,
        type:      editingMeta.type,
      },
      { method: "POST" }
    );
    setSelectedProduct((prev: any) => ({
      ...prev,
      metafields: prev.metafields.map((m: any) =>
        m.id === editingMeta.id ? { ...m, value: editValue } : m
      ),
    }));
    setEditingMeta(null);
  };

  // Collections table rows
  const rowMarkup = collections.map((coll: any, index: number) => (
    <IndexTable.Row id={coll.id} key={coll.id} position={index}>
      <IndexTable.Cell>
        <Text as="span" variant="bodyMd" fontWeight="semibold">{coll.title}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" tone="subdued" variant="bodySm">{coll.handle}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={coll.sortOrder === "MANUAL" ? "success" : "attention"}>
          {coll.sortOrder}
        </Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">{coll.metafields.length}</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <InlineStack gap="200">
          {/* Products button */}
          <Button size="slim" onClick={() => handleOpenProducts(coll)}>
            📦 {coll.productCount} Products
          </Button>
          {/* Collection metafields button */}
          <Button size="slim" variant="plain" onClick={() => setCollMetaModal(coll)}>
            Metafields
          </Button>
          {/* View on store */}
          <Button size="slim" variant="plain" url={coll.shopifyUrl} target="_blank">
            View ↗
          </Button>
        </InlineStack>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Collections" />
      <BlockStack gap="400">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">All Collections</Text>
                  <Button url="/app/import-export" variant="plain">Export CSV</Button>
                </InlineStack>

                <IndexTable
                  resourceName={{ singular: "collection", plural: "collections" }}
                  itemCount={collections.length}
                  headings={[
                    { title: "Title" },
                    { title: "Handle" },
                    { title: "Sort Order" },
                    { title: "Metafields" },
                    { title: "Actions" },
                  ]}
                  selectable={false}
                >
                  {rowMarkup}
                </IndexTable>

                <InlineStack align="space-between">
                  <Button disabled={!pageInfo.hasPreviousPage} url={`/app/collections?cursor=${pageInfo.startCursor}`}>Previous</Button>
                  <Button disabled={!pageInfo.hasNextPage}     url={`/app/collections?cursor=${pageInfo.endCursor}`}>Next</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>
      </BlockStack>

      {/* ── Collection Metafields Modal ────────────────────────────────────────── */}
      {collMetaModal && (
        <Modal
          open={!!collMetaModal}
          onClose={() => setCollMetaModal(null)}
          title={`${collMetaModal.title} — Metafields`}
          secondaryActions={[{ content: "Close", onAction: () => setCollMetaModal(null) }]}
          large
        >
          <Modal.Section>
            {collMetaModal.metafields.length === 0 ? (
              <EmptyState heading="No metafields" image="">
                <Text as="p">This collection has no metafields set.</Text>
              </EmptyState>
            ) : (
              <BlockStack gap="300">
                {collMetaModal.metafields.map((meta: any) => (
                  <Box key={meta.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                    <BlockStack gap="200">
                      <InlineStack align="space-between">
                        <InlineStack gap="200" blockAlign="center">
                          <MetaNamespaceBadge namespace={meta.namespace} />
                          <Text as="span" variant="bodySm" fontWeight="semibold">{meta.key}</Text>
                        </InlineStack>
                        <Badge tone="info">{meta.type}</Badge>
                      </InlineStack>
                      <Divider />
                      <Box padding="200" background="bg-surface" borderRadius="100">
                        <Text as="p" variant="bodySm" breakWord>
                          {meta.value.length > 400 ? meta.value.slice(0, 400) + "…" : meta.value}
                        </Text>
                      </Box>
                    </BlockStack>
                  </Box>
                ))}
              </BlockStack>
            )}
          </Modal.Section>
        </Modal>
      )}

      {/* ── Products Modal ─────────────────────────────────────────────────────── */}
      {productsModal && (
        <Modal
          open={!!productsModal}
          onClose={() => { setProductsModal(null); setSelectedProduct(null); }}
          title={`${productsModal.collection.title} — Products`}
          secondaryActions={[{ content: "Close", onAction: () => { setProductsModal(null); setSelectedProduct(null); } }]}
          large
        >
          <Modal.Section>
            {fetcher.state !== "idle" && !loadedProducts ? (
              <InlineStack align="center"><Spinner /> <Text as="span">Loading products…</Text></InlineStack>
            ) : loadedProducts && loadedProducts.length === 0 ? (
              <EmptyState heading="No products" image="">
                <Text as="p">This collection has no products.</Text>
              </EmptyState>
            ) : loadedProducts ? (
              <BlockStack gap="400">
                {fetcher.data?.intent === "save-metafield" && fetcher.data.success && (
                  <Banner tone="success">Metafield updated!</Banner>
                )}
                {fetcher.data?.intent === "save-metafield" && !fetcher.data.success && (
                  <Banner tone="critical">{fetcher.data.error}</Banner>
                )}

                {/* Product list */}
                {!selectedProduct && (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued" variant="bodySm">{loadedProducts.length} products in this collection</Text>
                    {loadedProducts.map((product: any) => (
                      <Box
                        key={product.id}
                        padding="300"
                        background="bg-surface-secondary"
                        borderRadius="200"
                      >
                        <InlineStack align="space-between" blockAlign="center">
                          <InlineStack gap="300" blockAlign="center">
                            {product.image ? (
                              <Thumbnail source={product.image} alt={product.title} size="small" />
                            ) : (
                              <Box background="bg-surface" borderRadius="200" minWidth="40px" minHeight="40px" />
                            )}
                            <BlockStack gap="050">
                              <Text as="span" variant="bodyMd" fontWeight="semibold">{product.title}</Text>
                              <Text as="span" variant="bodySm" tone="subdued">{product.handle}</Text>
                              <InlineStack gap="200">
                                <Badge tone={product.status === "ACTIVE" ? "success" : "attention"}>{product.status}</Badge>
                                <PriorityBadge metafields={product.metafields} />
                              </InlineStack>
                            </BlockStack>
                          </InlineStack>
                          <Button
                            size="slim"
                            onClick={() => { setSelectedProduct(product); setEditingMeta(null); }}
                          >
                            View Details
                          </Button>
                        </InlineStack>
                      </Box>
                    ))}
                  </BlockStack>
                )}

                {/* Product detail — all metafields */}
                {selectedProduct && (
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="300" blockAlign="center">
                        {selectedProduct.image && (
                          <Thumbnail source={selectedProduct.image} alt={selectedProduct.title} size="medium" />
                        )}
                        <BlockStack gap="100">
                          <Text as="h3" variant="headingMd">{selectedProduct.title}</Text>
                          <Text as="p" tone="subdued" variant="bodySm">{selectedProduct.handle}</Text>
                          <InlineStack gap="200">
                            <Badge tone={selectedProduct.status === "ACTIVE" ? "success" : "attention"}>{selectedProduct.status}</Badge>
                            <PriorityBadge metafields={selectedProduct.metafields} />
                          </InlineStack>
                        </BlockStack>
                      </InlineStack>
                      <Button variant="plain" onClick={() => { setSelectedProduct(null); setEditingMeta(null); }}>
                        ← Back to products
                      </Button>
                    </InlineStack>

                    <Divider />

                    <Text as="h3" variant="headingSm">Metafields ({selectedProduct.metafields.length})</Text>

                    {selectedProduct.metafields.length === 0 ? (
                      <Text as="p" tone="subdued">No metafields on this product.</Text>
                    ) : (
                      <BlockStack gap="300">
                        {selectedProduct.metafields.map((meta: any) => (
                          <Box key={meta.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                            <BlockStack gap="200">
                              <InlineStack align="space-between" blockAlign="start">
                                <InlineStack gap="200" blockAlign="center">
                                  <MetaNamespaceBadge namespace={meta.namespace} />
                                  <Text as="span" variant="bodySm" fontWeight="semibold">{meta.key}</Text>
                                </InlineStack>
                                <InlineStack gap="200">
                                  <Badge tone="info">{meta.type}</Badge>
                                  <Button size="slim" variant="plain" onClick={() => { setEditingMeta(meta); setEditValue(meta.value); }}>Edit</Button>
                                </InlineStack>
                              </InlineStack>
                              <Divider />
                              {editingMeta?.id === meta.id ? (
                                <InlineStack gap="200" blockAlign="end">
                                  <div style={{ flex: 1 }}>
                                    <TextField
                                      label="Value"
                                      value={editValue}
                                      onChange={setEditValue}
                                      autoComplete="off"
                                      multiline={meta.value.length > 80 ? 4 : undefined}
                                    />
                                  </div>
                                  <Button onClick={handleSaveMeta} loading={isSaving} variant="primary">Save</Button>
                                  <Button onClick={() => setEditingMeta(null)} variant="plain">Cancel</Button>
                                </InlineStack>
                              ) : (
                                <Box padding="200" background="bg-surface" borderRadius="100">
                                  <Text as="p" variant="bodySm" breakWord>
                                    {meta.value.length > 300 ? meta.value.slice(0, 300) + "…" : meta.value}
                                  </Text>
                                </Box>
                              )}
                            </BlockStack>
                          </Box>
                        ))}
                      </BlockStack>
                    )}
                  </BlockStack>
                )}
              </BlockStack>
            ) : null}
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
