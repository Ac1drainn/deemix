import { type ApiHandler } from "../../../types.js";

const path: ApiHandler["path"] = "/loginYTMusic";

const handler: ApiHandler["handler"] = async (req, res) => {
	const deemix = req.app.get("deemix");
	const cookie = req.body?.cookie;

	if (typeof cookie !== "string" || !cookie.trim()) {
		res.status(400).send({ loggedIn: false, error: "No cookie provided" });
		return;
	}

	try {
		res.send(await deemix.plugins.ytmusic.login(cookie));
	} catch (e: any) {
		res.send({ loggedIn: false, error: e.message });
	}
};

const apiHandler: ApiHandler = { path, handler };

export default apiHandler;
