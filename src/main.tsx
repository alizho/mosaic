import { startDesktopApp } from "./desktop-access";
import "./fonts.css";
import "./desktop-access.css";

const dispose = startDesktopApp(() => import("./app-bootstrap"));

if (import.meta.hot) import.meta.hot.dispose(dispose);
