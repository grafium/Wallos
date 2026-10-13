import { Hono } from "hono";
import type { AppBindings } from "../../env";

// login.php, registration.php, logout.php, passwordreset.php: being ported.
export const routes = new Hono<AppBindings>();
