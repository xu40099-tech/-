import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import RegionSelector from "./RegionSelector";

const isRegionSelector = new URLSearchParams(window.location.search).has("region-selector");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isRegionSelector ? <RegionSelector /> : <App />}
  </React.StrictMode>,
);
