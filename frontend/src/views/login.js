import m from "mithril";
import { api, ApiError } from "../api.js";

export const Login = {
  oninit(vnode) {
    vnode.state.username = "";
    vnode.state.password = "";
    vnode.state.error = null;
    vnode.state.busy = false;
    // If already authenticated, skip the form.
    api.me().then(() => m.route.set("/today")).catch(() => {});
  },
  view(vnode) {
    const s = vnode.state;
    const submit = (e) => {
      e.preventDefault();
      if (s.busy) return;
      s.busy = true;
      s.error = null;
      api
        .login(s.username, s.password)
        .then(() => m.route.set("/today"))
        .catch((err) => {
          s.error =
            err instanceof ApiError && err.status === 401
              ? "Invalid username or password"
              : err.message || "Login failed";
        })
        .finally(() => {
          s.busy = false;
          m.redraw();
        });
    };
    return m("form.login-card", { onsubmit: submit }, [
      m("h1", "Sign in"),
      m("label", { for: "u" }, "Username"),
      m("input#u", {
        type: "text",
        autocomplete: "username",
        value: s.username,
        oninput: (e) => (s.username = e.target.value),
        autofocus: true,
      }),
      m("label", { for: "p" }, "Password"),
      m("input#p", {
        type: "password",
        autocomplete: "current-password",
        value: s.password,
        oninput: (e) => (s.password = e.target.value),
      }),
      s.error ? m(".error", s.error) : null,
      m(
        "button.primary.submit",
        { type: "submit", disabled: s.busy },
        s.busy ? "Signing in…" : "Sign in"
      ),
    ]);
  },
};
