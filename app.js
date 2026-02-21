import { UiController } from "./ui.js";

const controller = new UiController();

window.addEventListener("DOMContentLoaded", () => {
  controller.init();
});
