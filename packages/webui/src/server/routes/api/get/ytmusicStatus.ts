import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/ytmusicStatus";

const handler: ApiHandler["handler"] = (req, res) => {
	const deemix = req.app.get("deemix");
	res.send(deemix.plugins.ytmusic.getStatus());
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
