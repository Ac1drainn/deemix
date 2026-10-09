import { logger } from "../../../helpers/logger.js";
import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/getYTMusicLibrary";

const handler: ApiHandler["handler"] = async (req, res) => {
	const deemix = req.app.get("deemix");

	if (!deemix.plugins.ytmusic.enabled) {
		res.send({ error: "ytmusicNotLoggedIn" });
		return;
	}

	try {
		res.send(await deemix.plugins.ytmusic.getLibrary());
	} catch (e: any) {
		logger.error(e);
		res.send({ error: "ytmusicRequestFailed", message: e.message });
	}
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
