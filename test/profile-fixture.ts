import type { Profile } from "../src/auth/profile.js";

// Independent provider contract fixture; each call owns its nested data.
export function profileFields(): Pick<Profile, "avatar" | "position"> {
  return {
    avatar: "https://example.invalid/avatar.png",
    position: {
      text: "Công ty Rita / Phòng Kỹ thuật",
      parser: {
        group: "", company: "Công ty Rita", department: "Phòng Kỹ thuật",
        board: "", region: "", store: "", warehouse: "", factory: "",
        workshop: "", showroom: "", center: "", cafe: "", others: ["Đội A"],
      },
    },
  };
}
