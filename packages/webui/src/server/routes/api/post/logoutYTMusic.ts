import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/logoutYTMusic";

const handler: ApiHandler["handler"] = (req, res) => {
	const deemix = req.app.get("deemix");
	deemix.plugins.ytmusic.logout();
	res.send(deemix.plugins.ytmusic.getStatus());
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
