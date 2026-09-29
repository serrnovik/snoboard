import { getPublicAuthView } from "../../server/auth/env.js";

export type LoginPageData = {
  password: boolean;
  github: boolean;
};

export function data(): LoginPageData {
  return getPublicAuthView();
}
