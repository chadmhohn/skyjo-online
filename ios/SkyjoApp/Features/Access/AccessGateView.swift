import SwiftUI

@MainActor
struct AccessGateView: View {
  @Bindable var model: AppModel
  @Bindable private var access: AccessFormModel

  init(model: AppModel) {
    self.model = model
    _access = Bindable(model.access)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          VStack(alignment: .leading, spacing: 12) {
            Image(systemName: "rectangle.stack.fill")
              .font(.largeTitle)
              .foregroundStyle(.tint)
              .accessibilityHidden(true)
            Text("Welcome to Skyjo")
              .font(.title.bold())
              .accessibilityIdentifier("access.title")
            Text("Enter the shared access password to reach this private game.")
              .foregroundStyle(.secondary)
          }
          .accessibilityElement(children: .combine)
        }

        Section("Shared access") {
          SecureField("Access password", text: $access.password)
            .textContentType(.password)
            .submitLabel(.continue)
            .onSubmit { submit() }
            .accessibilityIdentifier("access.password")

          Button {
            submit()
          } label: {
            HStack {
              Text("Continue")
              if model.access.isSubmitting {
                Spacer()
                ProgressView()
                  .accessibilityLabel("Signing in")
              }
            }
          }
          .disabled(!model.access.canSubmit)
          .accessibilityIdentifier("access.submit")
          .accessibilityHint("Unlocks the private Skyjo service")
        }

        if !model.access.errorMessage.isEmpty {
          Section {
            Label(model.access.errorMessage, systemImage: "exclamationmark.circle")
              .foregroundStyle(.red)
              .accessibilityIdentifier("access.error")
          }
        }
      }
      .navigationTitle("Skyjo")
      .disabled(model.access.isSubmitting)
    }
  }

  private func submit() {
    guard model.access.canSubmit else { return }
    Task { await model.submitAccess() }
  }
}

@MainActor
struct AuthenticationView: View {
  @Bindable var model: AppModel
  @Bindable private var authentication: AuthenticationFormModel

  init(model: AppModel) {
    self.model = model
    _authentication = Bindable(model.authentication)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Account action", selection: $authentication.mode) {
            ForEach(AuthenticationMode.allCases) { mode in
              Text(mode.rawValue).tag(mode)
            }
          }
          .pickerStyle(.segmented)
          .accessibilityIdentifier("auth.mode")
          .onChange(of: model.authentication.mode) {
            model.authentication.errorMessage = ""
            model.authentication.clearSensitiveFields()
          }
        }

        Section(model.authentication.mode.rawValue) {
          TextField("Email", text: $authentication.email)
            .textContentType(.emailAddress)
            .keyboardType(.emailAddress)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityIdentifier("auth.email")

          if model.authentication.mode == .signup {
            TextField("Display name", text: $authentication.displayName)
              .textContentType(.name)
              .accessibilityIdentifier("auth.display-name")
          }

          SecureField("Password", text: $authentication.password)
            .textContentType(model.authentication.mode == .signup ? .newPassword : .password)
            .accessibilityIdentifier("auth.password")

          if model.authentication.mode == .signup {
            SecureField("Confirm password", text: $authentication.confirmPassword)
              .textContentType(.newPassword)
              .submitLabel(.go)
              .onSubmit { submit() }
              .accessibilityIdentifier("auth.confirm-password")
          }

          Button {
            submit()
          } label: {
            HStack {
              Text(model.authentication.mode.rawValue)
              if model.authentication.isSubmitting {
                Spacer()
                ProgressView()
                  .accessibilityLabel("Submitting account request")
              }
            }
          }
          .disabled(!model.authentication.canSubmit)
          .accessibilityIdentifier("auth.submit")
        }

        if model.authentication.mode == .signup {
          Section {
            Text("Passwords must be at least 8 characters. Account sessions are kept by secure server cookies; the app does not save your password.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
        }

        if !model.authentication.errorMessage.isEmpty {
          Section {
            Label(model.authentication.errorMessage, systemImage: "exclamationmark.circle")
              .foregroundStyle(
                model.authentication.errorMessage.hasPrefix("Password changed")
                  ? Color.secondary
                  : Color.red
              )
              .accessibilityIdentifier("auth.error")
          }
        }
      }
      .navigationTitle("Your Account")
      .disabled(model.authentication.isSubmitting)
    }
  }

  private func submit() {
    guard model.authentication.canSubmit else { return }
    Task { await model.submitAuthentication() }
  }
}
