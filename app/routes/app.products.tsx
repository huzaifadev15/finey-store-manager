import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import {
  Page, Layout, Card, Text, BlockStack, IndexTable,
  Badge, Button, TextField, InlineStack, Spinner, Banner,
  Modal, DataTable, Box, Divider, EmptyState, Tooltip,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { useState, useCallback } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;

  const res = await admin.graphql(`#graphql
    query getProducts($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage hasPreviousPage endCursor startCursor }
        edges {
          node {
            id title handle status
            featuredImage { url altText }
            metafields(first: 30) {
              edges {
                node {
                  id namespace key value type
                }
              }
            }
          }
        }
      }
    }
  `, { variables: { cursor } });

  const data = await res.json();
  const conn = data.data.products;

  return {
    products: conn.edges.map((e: any) => ({
      id:         e.node.id,
      title:      e.node.title,
      handle:     e.node.handle,
      status:     e.node.status,
      image:      e.node.featuredImage?.url ?? null,
      metafields: e.node.metafields.edges.map((m: any) => ({
        id:        m.node.id,
        namespace: m.node.namespace,
        key:       m.node.key,
        value:     m.node.value,
        type:      m.node.type,
      })),
    })),
    pageInfo: conn.pageInfo,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId  = formData.get("productId")  as string;
  const namespace  = formData.get("namespace")  as string;
  const key        = formData.get("key")        as string;
  const value      = formData.get("value")      as string;
  const type       = formData.get("type")       as string;

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
  if (errors.length > 0) return { success: false, error: errors[0].message };
  return { success: true };
};

function truncate(str: string, max = 60) {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

function MetafieldBadge({ namespace, metakey }: { namespace: string; metakey: string }) {
  const colors: Record<string, any> = {
    custom: "info",
    seo: "success",
    global: "attention",
    shopify: undefined,
  };
  return (
    <InlineStack gap="100">
      <Badge tone={colors[namespace] ?? undefined}>{namespace}</Badge>
      <Text as="span" variant="bodySm" fontWeight="semibold">{metakey}</Text>
    </InlineStack>
  );
}

export default function Products() {
  const { products, pageInfo } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [editingMeta, setEditingMeta]         = useState<any | null>(null);
  const [editValue, setEditValue]             = useState("");

  const isLoading = fetcher.state !== "idle";

  const handleEditMeta = (meta: any) => {
    setEditingMeta(meta);
    setEditValue(meta.value);
  };

  const handleSaveMeta = () => {
    if (!editingMeta || !selectedProduct) return;
    fetcher.submit(
      {
        productId: selectedProduct.id,
        namespace: editingMeta.namespace,
        key:       editingMeta.key,
        value:     editValue,
        type:      editingMeta.type,
      },
      { method: "POST" }
    );
    // Optimistically update local state
    setSelectedProduct((prev: any) => ({
      ...prev,
      metafields: prev.metafields.map((m: any) =>
        m.id === editingMeta.id ? { ...m, value: editValue } : m
      ),
    }));
    setEditingMeta(null);
  };

  const rowMarkup = products.map((product: any, index: number) => (
    <IndexTable.Row id={product.id} key={product.id} position={index}>
      <IndexTable.Cell>
        <InlineStack gap="300" blockAlign="center">
          {product.image
            ? <img src={product.image} alt={product.title} style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 6 }} />
            : <Box background="bg-surface-secondary" borderRadius="200" minWidth="40px" minHeight="40px" />
          }
          <BlockStack gap="0">
            <Text as="span" variant="bodyMd" fontWeight="semibold">{product.title}</Text>
            <Text as="span" variant="bodySm" tone="subdued">{product.handle}</Text>
          </BlockStack>
        </InlineStack>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Badge tone={product.status === "ACTIVE" ? "success" : "attention"}>{product.status}</Badge>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Text as="span" variant="bodySm">{product.metafields.length} metafields</Text>
      </IndexTable.Cell>
      <IndexTable.Cell>
        {/* Quick priority badge */}
        {(() => {
          const p = product.metafields.find((m: any) => m.namespace === "custom" && m.key === "priority");
          if (!p) return <Text as="span" tone="subdued" variant="bodySm">—</Text>;
          const toneMap: Record<string, any> = { "1": "success", "2": "info", "3": "attention", "5": "critical" };
          return <Badge tone={toneMap[p.value]}>{`P${p.value}`}</Badge>;
        })()}
      </IndexTable.Cell>
      <IndexTable.Cell>
        <Button size="slim" onClick={() => setSelectedProduct(product)}>View Metafields</Button>
      </IndexTable.Cell>
    </IndexTable.Row>
  ));

  return (
    <Page>
      <TitleBar title="Products & Metafields" />
      <BlockStack gap="400">

        {/* Product table */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">All Products</Text>
                <IndexTable
                  resourceName={{ singular: "product", plural: "products" }}
                  itemCount={products.length}
                  headings={[
                    { title: "Product" },
                    { title: "Status" },
                    { title: "Metafields" },
                    { title: "Priority" },
                    { title: "" },
                  ]}
                  selectable={false}
                >
                  {rowMarkup}
                </IndexTable>
                <InlineStack align="space-between">
                  <Button disabled={!pageInfo.hasPreviousPage} url={`/app/products?cursor=${pageInfo.startCursor}`}>Previous</Button>
                  <Button disabled={!pageInfo.hasNextPage}     url={`/app/products?cursor=${pageInfo.endCursor}`}>Next</Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        {/* Metafields modal */}
        {selectedProduct && (
          <Modal
            open={!!selectedProduct}
            onClose={() => { setSelectedProduct(null); setEditingMeta(null); }}
            title={selectedProduct.title}
            secondaryActions={[{ content: "Close", onAction: () => { setSelectedProduct(null); setEditingMeta(null); } }]}
            large
          >
            <Modal.Section>
              {fetcher.data?.success === false && (
                <Banner tone="critical">{fetcher.data.error}</Banner>
              )}
              {fetcher.data?.success === true && (
                <Banner tone="success">Metafield updated successfully!</Banner>
              )}

              {selectedProduct.metafields.length === 0 ? (
                <EmptyState heading="No metafields found" image="">
                  <Text as="p">This product has no metafields set.</Text>
                </EmptyState>
              ) : (
                <BlockStack gap="400">
                  {selectedProduct.metafields.map((meta: any) => (
                    <Box key={meta.id} padding="300" background="bg-surface-secondary" borderRadius="200">
                      <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="start">
                          <MetafieldBadge namespace={meta.namespace} metakey={meta.key} />
                          <InlineStack gap="200">
                            <Badge tone="info">{meta.type}</Badge>
                            <Button
                              size="slim"
                              variant="plain"
                              onClick={() => handleEditMeta(meta)}
                            >
                              Edit
                            </Button>
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
                            <Button onClick={handleSaveMeta} loading={isLoading} variant="primary">Save</Button>
                            <Button onClick={() => setEditingMeta(null)} variant="plain">Cancel</Button>
                          </InlineStack>
                        ) : (
                          <Box padding="200" background="bg-surface" borderRadius="100">
                            <Text as="p" variant="bodySm" breakWord>
                              {meta.value.length > 300 ? truncate(meta.value, 300) : meta.value}
                            </Text>
                          </Box>
                        )}
                      </BlockStack>
                    </Box>
                  ))}
                </BlockStack>
              )}
            </Modal.Section>
          </Modal>
        )}

      </BlockStack>
    </Page>
  );
}
