import { render } from "preact";
import { BookApp } from "./app";
import "./book.css";

render(<BookApp />, document.getElementById("app")!);
