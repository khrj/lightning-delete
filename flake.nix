{
	description = "Delete your recent slack messages. Instantly";
	inputs.nixpkgs.url = "github:nixos/nixpkgs";

	outputs = { self, nixpkgs }:
		let pkgs = nixpkgs.legacyPackages.x86_64-linux;
		in {
			devShell.x86_64-linux = pkgs.mkShell {
				buildInputs = with pkgs; [
					nodejs-16_x
					nodePackages.npm
				];
			};
		};
}
