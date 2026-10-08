export const LOCAL_MODEL_ID = "onnx-community/Qwen2.5-0.5B-Instruct";
export const LOCAL_MODEL_DTYPE = "q4" as const;

export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAl5f8AjI7/4vGRYqDcQMuifGxeQFBjWjxCN8/6GiY4mGVkRoc41FaFZbpqLhgNNrCB82o6Bp6PA1PjSFaw++syZZUSbWWr0YmmFObD5LT7g3g7WFyw0rsm+5dNAAoLWiOI9TFIM2US5oF3e/6+OWMotbv8Zqjk4n1PGWsqx2EoPWRRpFEtmFRnDuWaCIp4Gigx5mxiNJdvQwYzVLydGKua/9I5H/sCyEAVmK7FVSYc5PzDKE7dnpPuDnfrChh1Mt7N4Hv2RovzlQ/hbv+7SYBk5rVC+DLbkSsyXWFN+3hrXnTMlS9UMWzgbw8PUxjpUy/hNndOxXY7ncWqCgHQFJABwIDAQAB";

export const EXTENSION_ID = "ilghkafjpaojhclmnebepddhmndelhjl";

export async function chromeExtensionIdFromKey(base64Key: string): Promise<string> {
  const binary = atob(base64Key);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = new Uint8Array(digest).slice(0, 16);
  return [...hash]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .split("")
    .map((hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
    .join("");
}
