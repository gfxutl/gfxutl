import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AboutPage } from "./components/about-page";
import { I18nProvider } from "./core/i18n";
import "./styles.css";
import "./about-page.css";

const aboutRoute = window.location.pathname === "/about" || window.location.pathname === "/about/";
if (aboutRoute) {
  document.body.classList.add("about-route");
  document.title = "GfxUtlのお部屋";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", "#efffef");
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no");
}

ReactDOM.createRoot(document.getElementById("main")!).render(
  <React.StrictMode>
    <I18nProvider>{aboutRoute ? <AboutPage /> : <App />}</I18nProvider>
  </React.StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/" });
  });
}
