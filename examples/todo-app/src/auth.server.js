export function login(user, pass) {
	if (user === "admin" && pass === "admin") {
		return {
			user: "admin",
			role: "admin",
		};
	} else {
		throw new Error("Invalid user or password");
	}
}

export function logout() {
	return true;
}
