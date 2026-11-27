import { render } from "preact";
import { App as KonstaApp } from "konsta/react";
import { App } from "./app";
import "./styles.css";

// Konsta UI gives the phone look (iOS theme). The app has a light theme only.
render(
  <KonstaApp theme="ios" dark={false} safeAreas={false}>
    <App />
  </KonstaApp>,
  document.getElementById("app")!,
);
